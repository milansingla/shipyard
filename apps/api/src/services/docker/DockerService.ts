import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type Docker from "dockerode";
import tar from "tar-fs";

import { AppError, ErrorCode, NotFoundError, ValidationError, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { createContextFilter } from "./buildContext.js";
import { type BuildEvent, interpretBuildEvent } from "./buildOutput.js";
import { type LogChunk, type LogStream, demuxDockerLogs } from "./logs.js";
import type { RegistryCredentials } from "../registry/ImageRegistry.js";
import { isValidContainerReference } from "./naming.js";

/**
 * Labels Shipyard puts on every image/container it creates. They let us
 * (a) refuse to touch containers Shipyard does not own, and
 * (b) recover deployment metadata from Docker itself.
 */
export const ShipyardLabel = {
  MANAGED: "shipyard.managed",
  DEPLOYMENT_ID: "shipyard.deployment-id",
  PROJECT_ID: "shipyard.project-id",
  REPOSITORY: "shipyard.repository",
  CONTAINER_PORT: "shipyard.container-port",
  /** Health check settings the container was created with, so a later restart checks it the same way. */
  HEALTH_PATH: "shipyard.health-path",
  HEALTH_PORT: "shipyard.health-port",
  HEALTH_TIMEOUT_MS: "shipyard.health-timeout-ms",
  /** The service's name within its project. */
  SERVICE: "shipyard.service",
  /** "docker": healthy when the image's own check (Docker HEALTHCHECK) says so, e.g. pg_isready. */
  HEALTH_KIND: "shipyard.health-kind",
  /** 1-based replica number within its deployment. */
  REPLICA: "shipyard.replica",
} as const;

/** How a container is health-checked. */
export interface HealthCheckSettings {
  path: string;
  /** null = the app's own port. */
  port: number | null;
  /** null = the server default. */
  timeoutMs: number | null;
}

export interface ContainerState {
  /** False while Docker is restarting a crashed process: the app is not up. */
  running: boolean;
  exitCode: number | null;
  /** The kernel killed it for exceeding its memory limit. */
  oomKilled: boolean;
  /** Docker's own health status, for containers created with a health command. */
  health?: "starting" | "healthy" | "unhealthy" | null;
}

export type RestartPolicy = "NO" | "ON_FAILURE" | "UNLESS_STOPPED";

export interface ContainerResources {
  /** CPUs, e.g. 0.5; null = no limit. */
  cpuLimit: number | null;
  /** MB; null = no limit. Swap is disabled when set. */
  memoryLimitMb: number | null;
  restartPolicy: RestartPolicy;
}

const RESTART_POLICY: Record<RestartPolicy, { Name: string; MaximumRetryCount?: number }> = {
  NO: { Name: "no" },
  ON_FAILURE: { Name: "on-failure", MaximumRetryCount: 5 },
  UNLESS_STOPPED: { Name: "unless-stopped" },
};

export interface ManagedContainer extends ContainerState {
  id: string;
  name: string;
  deploymentId: string | null;
  containerPort: number;
  hostPort: number | null;
  /** Docker networks the container is attached to. */
  networks: string[];
  healthCheck: HealthCheckSettings;
  /** Published port the health check is sent to (the app's own, or a separate health port). */
  healthHostPort: number | null;
  /** Checked by Docker with a command (HEALTH_KIND "docker"), not over HTTP; nothing is published. */
  dockerHealthCheck: boolean;
}

export interface CreateContainerOptions {
  imageName: string;
  containerName: string;
  /** null = a worker: no port, nothing published. */
  containerPort: number | null;
  /** The project's private network, where `alias` (the service name) resolves to this container. */
  privateNetwork?: { name: string; alias: string } | null;
  /** Overrides the image's command (exec form). */
  command?: string[];
  /** Named volumes to mount. */
  volumes?: ReadonlyArray<{ name: string; mountPath: string }>;
  labels: Record<string, string>;
  /** Docker network to attach the container to (instead of the default bridge), e.g. the proxy's. */
  network?: string | null;
  /** The app's environment variables. PORT is always Shipyard's. */
  env?: Record<string, string>;
  /** A separate port to publish (loopback) for health checks. */
  healthCheckPort?: number | null;
  /** Default: no limits, never restarted by Docker. */
  resources?: ContainerResources;
  /** A command Docker runs inside the container to decide it is healthy (exit 0), every second. */
  healthCommand?: string[];
}

export interface StartedContainer {
  id: string;
  /** null for workers (nothing published). */
  hostPort: number | null;
  /** Where to send health checks: hostPort, or the separate health port's published port. */
  healthHostPort: number | null;
}

interface DockerServiceOptions {
  /** Interface the container's port is published on (127.0.0.1 = local only). */
  publishHost: string;
  /** A build running longer than this is cancelled. */
  buildTimeoutMs: number;
}

const STOP_TIMEOUT_SECONDS = 10;
// Runtime logs live in Docker's json-file driver; cap them at 3 × 10 MB per container.
const RUNTIME_LOG_CONFIG = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };
const DEFAULT_LOG_TAIL = 200;

/**
 * Thin, typed wrapper around the Docker Engine API (via Dockerode).
 * Knows about containers and images — NOT about deployments or statuses.
 */
export class DockerService {
  constructor(
    private readonly docker: Docker,
    private readonly options: DockerServiceOptions,
    private readonly logger: Logger,
  ) {}

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Builds an image from `contextDir`. Resolves only if Docker reports no error.
   * `onLog` receives raw build output as it streams. `dockerfile` is relative to the context.
   * Cancelled after `buildTimeoutMs`: closing the connection makes Docker abort the build.
   */
  async buildImage(
    contextDir: string,
    imageName: string,
    labels: Record<string, string>,
    onLog: (text: string) => void,
    dockerfile = "Dockerfile",
    buildArgs: Record<string, string> = {},
  ): Promise<void> {
    const context = tar.pack(contextDir, { ignore: await createContextFilter(contextDir, dockerfile) });

    const abort = new AbortController();
    let stream: NodeJS.ReadableStream;
    try {
      // tar-fs returns a streamx stream: pipe-compatible at runtime, but not typed as a Node ReadableStream.
      stream = await this.docker.buildImage(context as unknown as NodeJS.ReadableStream, {
        t: imageName,
        dockerfile,
        labels,
        buildargs: buildArgs,
        rm: true,
        forcerm: true, // remove intermediate containers even when the build fails
        abortSignal: abort.signal,
      });
    } catch (error) {
      throw this.dockerError(ErrorCode.DOCKER_BUILD_FAILED, "Docker refused the build request", error);
    }

    let buildError: string | null = null;
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        reject(
          new AppError(
            ErrorCode.DOCKER_BUILD_FAILED,
            `Docker build timed out after ${Math.round(this.options.buildTimeoutMs / 1000)}s and was cancelled.`,
            { statusCode: 422 },
          ),
        );
      }, this.options.buildTimeoutMs);
    });

    const progress = new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (error: Error | null) => (error ? reject(error) : resolve()),
        (event: BuildEvent) => {
          const interpreted = interpretBuildEvent(event);
          if (interpreted.log) onLog(interpreted.log);
          if (interpreted.error) {
            buildError = interpreted.error;
            onLog(`ERROR: ${interpreted.error}\n`);
          }
        },
      );
    }).catch((error: unknown) => {
      throw this.dockerError(ErrorCode.DOCKER_BUILD_FAILED, "Docker build stream failed", error);
    });

    try {
      await Promise.race([progress, timeout]);
    } finally {
      clearTimeout(timer);
      progress.catch(() => {}); // after a timeout, the aborted stream's error is expected
    }

    if (buildError !== null) {
      throw new AppError(ErrorCode.DOCKER_BUILD_FAILED, `Docker build failed: ${buildError}`, { statusCode: 422 });
    }
  }

  /** Pushes a local image to its registry; credentials go in the request, never in logs. */
  /** Pulls a prebuilt image unless it is already here: the same tag gives the same image on every deploy. */
  async ensureImage(imageName: string, onLog: (text: string) => void): Promise<void> {
    const present = await this.docker
      .getImage(imageName)
      .inspect()
      .then(
        () => true,
        (error: unknown) => {
          if (isDockerNotFound(error)) return false;
          throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not inspect image", error);
        },
      );
    if (present) {
      onLog(`Using ${imageName} (already on this server)\n`);
      return;
    }
    onLog(`Pulling ${imageName}\n`);
    try {
      const stream = await this.docker.pull(imageName);
      await new Promise<void>((resolve, reject) =>
        this.docker.modem.followProgress(stream, (error: Error | null) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      throw this.dockerError(ErrorCode.IMAGE_PULL_FAILED, `Could not pull ${imageName}`, error);
    }
    onLog(`Pulled ${imageName}\n`);
  }

  async pushImage(imageName: string, credentials: RegistryCredentials | null, onLog: (text: string) => void): Promise<void> {
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.docker.getImage(imageName).push(credentials ? { authconfig: credentials } : {});
    } catch (error) {
      throw this.dockerError(ErrorCode.IMAGE_PUSH_FAILED, `Could not push ${imageName}`, error);
    }
    let failure: string | null = null;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (error: Error | null) => (error ? reject(error) : resolve()),
        (event: { status?: string; id?: string; error?: string; errorDetail?: { message?: string } }) => {
          if (event.error) failure = event.errorDetail?.message ?? event.error;
          // Layer-by-layer progress is noise; keep the outcome lines.
          else if (event.status && !event.id) onLog(`${event.status}\n`);
        },
      );
    }).catch((error: unknown) => {
      throw this.dockerError(ErrorCode.IMAGE_PUSH_FAILED, `Could not push ${imageName}`, error);
    });
    if (failure) {
      throw new AppError(ErrorCode.IMAGE_PUSH_FAILED, `Pushing ${imageName} failed: ${failure}`, { statusCode: 422 });
    }
  }

  async createAndStartContainer(options: CreateContainerOptions): Promise<StartedContainer> {
    const ports = options.containerPort === null ? [] : [options.containerPort];
    if (options.containerPort !== null && options.healthCheckPort && options.healthCheckPort !== options.containerPort) {
      ports.push(options.healthCheckPort);
    }
    // The private (project) network first: it's where the service's name resolves.
    const networks = [
      ...(options.privateNetwork ? [{ name: options.privateNetwork.name, aliases: [options.privateNetwork.alias] }] : []),
      ...(options.network ? [{ name: options.network, aliases: [] as string[] }] : []),
    ];
    for (const network of networks) await this.assertNetworkExists(network.name);

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        Image: options.imageName,
        name: options.containerName,
        // PORT last: if a key appears twice, Docker keeps the last one.
        Env: [
          ...Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
          ...(options.containerPort === null ? [] : [`PORT=${options.containerPort}`]),
        ],
        ...(options.command ? { Cmd: options.command } : {}),
        ...(options.healthCommand && {
          Healthcheck: {
            Test: ["CMD", ...options.healthCommand],
            Interval: 1_000_000_000,
            Timeout: 5_000_000_000,
            Retries: 3,
            // Failures while it initialises (a new database) don't count.
            StartPeriod: 300_000_000_000,
          },
        }),
        Labels: options.labels,
        ExposedPorts: Object.fromEntries(ports.map((port) => [`${port}/tcp`, {}])),
        HostConfig: {
          // HostPort "" = let Docker pick a free ephemeral port. A separate health port is
          // only for Shipyard's own checks, so it is always loopback-only.
          PortBindings: Object.fromEntries(
            ports.map((port, index) => [
              `${port}/tcp`,
              [{ HostIp: index === 0 ? this.options.publishHost : "127.0.0.1", HostPort: "" }],
            ]),
          ),
          ...(networks[0] ? { NetworkMode: networks[0].name } : {}),
          ...(options.volumes?.length && {
            Mounts: options.volumes.map((volume) => ({ Type: "volume" as const, Source: volume.name, Target: volume.mountPath })),
          }),
          ...resourceConfig(options.resources),
          LogConfig: RUNTIME_LOG_CONFIG,
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 512,
        },
        ...(networks.length > 0 && {
          NetworkingConfig: {
            EndpointsConfig: Object.fromEntries(networks.map((network) => [network.name, { Aliases: network.aliases }])),
          },
        }),
      });
      await container.start();
    } catch (error) {
      throw this.dockerError(ErrorCode.CONTAINER_START_FAILED, "Could not start container", error);
    }

    const managed = await this.inspectManagedContainer(container.id);
    if (options.containerPort !== null && (managed.hostPort === null || managed.healthHostPort === null)) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, "Docker did not assign a host port.");
    }
    return { id: container.id, hostPort: managed.hostPort, healthHostPort: managed.healthHostPort };
  }

  /** Creates a Shipyard-managed named volume if missing. Returns true when it was just created. */
  async ensureVolume(name: string, labels: Record<string, string>): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return false;
    } catch (error) {
      if (!isDockerNotFound(error)) throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not inspect volume", error);
    }
    try {
      await this.docker.createVolume({ Name: name, Labels: { ...labels, [ShipyardLabel.MANAGED]: "true" } });
      return true;
    } catch (error) {
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not create volume", error);
    }
  }

  /**
   * A new volume is owned by root. Apps that run as another user (the
   * generated Dockerfiles use `node`) couldn't write to it, so it is handed
   * to the image's user once, by a short-lived container of that image.
   */
  async prepareVolumeOwnership(volumeName: string, imageName: string, mountPath: string): Promise<void> {
    const image = await this.docker.getImage(imageName).inspect();
    const user = image.Config?.User?.trim();
    if (!user || user === "root" || user === "0" || user.startsWith("0:")) return;

    const container = await this.docker.createContainer({
      Image: imageName,
      User: "0",
      Entrypoint: ["chown", "-R", user, mountPath],
      Cmd: [],
      Labels: { [ShipyardLabel.MANAGED]: "true" },
      HostConfig: { Mounts: [{ Type: "volume", Source: volumeName, Target: mountPath }], NetworkMode: "none", AutoRemove: false },
    });
    try {
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      if (StatusCode !== 0) {
        throw new AppError(ErrorCode.CONTAINER_START_FAILED, `Could not give ${mountPath} to user ${user} (exit ${StatusCode}).`, { statusCode: 422 });
      }
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  /** Removes a Shipyard-managed volume and its data. Missing volumes are ignored; never someone else's. */
  async removeVolume(name: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(name);
      const info = (await volume.inspect()) as { Labels?: Record<string, string> | null };
      if (info.Labels?.[ShipyardLabel.MANAGED] !== "true") return;
      await volume.remove();
    } catch (error) {
      if (isDockerNotFound(error)) return;
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not remove volume", error);
    }
  }

  /** Creates a Shipyard-managed bridge network if it doesn't exist yet. Idempotent. */
  async ensureNetwork(name: string, labels: Record<string, string>): Promise<void> {
    try {
      await this.docker.getNetwork(name).inspect();
      return;
    } catch (error) {
      if (!isDockerNotFound(error)) throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not inspect Docker network", error);
    }
    try {
      await this.docker.createNetwork({ Name: name, Driver: "bridge", Labels: { ...labels, [ShipyardLabel.MANAGED]: "true" } });
    } catch (error) {
      // Created concurrently by another deploy: fine.
      if (dockerStatusCode(error) !== 409) throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not create Docker network", error);
    }
  }

  /** Removes a Shipyard-managed network. Missing networks are ignored. */
  async removeNetwork(name: string): Promise<void> {
    try {
      const network = this.docker.getNetwork(name);
      const info = (await network.inspect()) as { Labels?: Record<string, string> };
      if (info.Labels?.[ShipyardLabel.MANAGED] !== "true") return; // never someone else's
      await network.remove();
    } catch (error) {
      if (isDockerNotFound(error)) return;
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not remove Docker network", error);
    }
  }


  /**
   * Looks up a container by name or id and verifies Shipyard created it.
   * Containers without the shipyard.managed label are reported as not found,
   * so Shipyard can never be used to stop/inspect unrelated containers.
   */
  async inspectManagedContainer(reference: string): Promise<ManagedContainer> {
    if (!isValidContainerReference(reference)) {
      throw new ValidationError(`Invalid container reference: ${reference}`);
    }

    let info: Docker.ContainerInspectInfo;
    try {
      info = await this.docker.getContainer(reference).inspect();
    } catch (error) {
      if (isDockerNotFound(error)) throw new NotFoundError(`Container not found: ${reference}`);
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not inspect container", error);
    }

    const labels = info.Config.Labels ?? {};
    if (labels[ShipyardLabel.MANAGED] !== "true") {
      throw new NotFoundError(`Container not found: ${reference}`);
    }

    const containerPort = Number(labels[ShipyardLabel.CONTAINER_PORT] ?? 0);
    const publishedPort = (port: number): number | null => {
      if (!port) return null; // a worker: no port
      const binding = info.NetworkSettings.Ports?.[`${port}/tcp`]?.[0];
      return binding?.HostPort ? Number(binding.HostPort) : null;
    };
    // Containers from before V3 have no health labels: "/" on the app's port, default timeout.
    const healthCheck: HealthCheckSettings = {
      path: labels[ShipyardLabel.HEALTH_PATH] ?? "/",
      port: optionalNumber(labels[ShipyardLabel.HEALTH_PORT]),
      timeoutMs: optionalNumber(labels[ShipyardLabel.HEALTH_TIMEOUT_MS]),
    };

    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ""),
      deploymentId: labels[ShipyardLabel.DEPLOYMENT_ID] ?? null,
      containerPort,
      hostPort: publishedPort(containerPort),
      healthCheck,
      healthHostPort: containerPort ? publishedPort(healthCheck.port ?? containerPort) : null,
      networks: Object.keys(info.NetworkSettings.Networks ?? {}),
      dockerHealthCheck: labels[ShipyardLabel.HEALTH_KIND] === "docker",
      health: (info.State.Health?.Status as ContainerState["health"]) ?? null,
      // A crash-looping container under a restart policy reports Running *and* Restarting.
      running: info.State.Running && !info.State.Restarting,
      exitCode: info.State.Running && !info.State.Restarting ? null : info.State.ExitCode,
      oomKilled: info.State.OOMKilled === true,
    };
  }

  async getContainerState(containerId: string): Promise<ContainerState> {
    const { running, exitCode, oomKilled, health } = await this.inspectManagedContainer(containerId);
    return { running, exitCode, oomKilled, health };
  }

  async getLogs(containerId: string, tail: number = DEFAULT_LOG_TAIL): Promise<LogChunk[]> {
    const buffer = await this.docker.getContainer(containerId).logs({
      stdout: true,
      stderr: true,
      timestamps: false,
      tail,
      follow: false,
    });
    return demuxDockerLogs(buffer);
  }

  /**
   * Follows a container's output (`docker logs --follow`) until it stops or
   * `signal` aborts. Starts with the last `tail` lines.
   */
  async followLogs(
    containerId: string,
    tail: number,
    onChunk: (chunk: LogChunk) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const stream = (await this.docker.getContainer(containerId).logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail,
      timestamps: false,
    })) as unknown as NodeJS.ReadableStream & { destroy(): void };

    const sink = (name: LogStream) => {
      const decoder = new StringDecoder("utf8");
      return new Writable({
        write(chunk: Buffer, _encoding, done) {
          const text = decoder.write(chunk);
          if (text) onChunk({ stream: name, text });
          done();
        },
      });
    };
    // Shipyard containers have no TTY, so the stream is multiplexed (see logs.ts).
    this.docker.modem.demuxStream(stream, sink("stdout"), sink("stderr"));

    await new Promise<void>((resolve) => {
      const stop = () => {
        stream.destroy();
        resolve();
      };
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", resolve);
    });
  }

  async stopContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).stop({ t: STOP_TIMEOUT_SECONDS });
    } catch (error) {
      // 304 = already stopped. Stopping is idempotent from our point of view.
      if (dockerStatusCode(error) === 304) return;
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not stop container", error);
    }
  }

  /** Ids of every container of a deployment (its replicas), in replica order. */
  async deploymentContainers(deploymentId: string): Promise<string[]> {
    let containers: Docker.ContainerInfo[];
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`${ShipyardLabel.MANAGED}=true`, `${ShipyardLabel.DEPLOYMENT_ID}=${deploymentId}`] },
      });
    } catch (error) {
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not list containers", error);
    }
    const replica = (container: Docker.ContainerInfo) => Number(container.Labels?.[ShipyardLabel.REPLICA] ?? 1);
    return containers.sort((a, b) => replica(a) - replica(b)).map((container) => container.Id);
  }

  /** Attaches a running or stopped container to a network. */
  async connectToNetwork(containerId: string, network: string): Promise<void> {
    await this.assertNetworkExists(network);
    try {
      await this.docker.getNetwork(network).connect({ Container: containerId });
    } catch (error) {
      throw this.dockerError(ErrorCode.CONTAINER_START_FAILED, `Could not attach container to network ${network}`, error);
    }
  }

  async restartContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).restart({ t: STOP_TIMEOUT_SECONDS });
    } catch (error) {
      throw this.dockerError(ErrorCode.CONTAINER_START_FAILED, "Could not restart container", error);
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: true });
    } catch (error) {
      if (isDockerNotFound(error)) return;
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not remove container", error);
    }
  }

  /** Removes an image Shipyard built. Never a prebuilt one (postgres:17-alpine): other projects may use it. */
  async removeImage(imageName: string): Promise<void> {
    try {
      const image = this.docker.getImage(imageName);
      const info = (await image.inspect()) as { Config?: { Labels?: Record<string, string> | null } };
      if (info.Config?.Labels?.[ShipyardLabel.MANAGED] !== "true") return;
      await image.remove({ force: true });
    } catch (error) {
      if (isDockerNotFound(error)) return;
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not remove image", error);
    }
  }

  /** Checked up front: Docker's own error for a missing network doesn't say how to fix it. */
  private async assertNetworkExists(network: string): Promise<void> {
    try {
      await this.docker.getNetwork(network).inspect();
    } catch (error) {
      if (isDockerNotFound(error)) {
        throw new AppError(
          ErrorCode.CONTAINER_START_FAILED,
          `Docker network "${network}" doesn't exist. Start Traefik with \`npm run db:up\`; it creates the network.`,
          { statusCode: 422 },
        );
      }
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not inspect Docker network", error);
    }
  }

  private dockerError(code: ErrorCode, message: string, cause: unknown): AppError {
    this.logger.debug({ err: cause }, message);
    return new AppError(code, `${message}: ${errorMessage(cause)}`, { cause });
  }
}

/** Docker HostConfig for a container's limits. Values were validated when the project was saved. */
export function resourceConfig(resources: ContainerResources | undefined): Partial<Docker.HostConfig> {
  if (!resources) return { RestartPolicy: RESTART_POLICY.NO };
  const memoryBytes = resources.memoryLimitMb === null ? undefined : resources.memoryLimitMb * 1024 * 1024;
  return {
    RestartPolicy: RESTART_POLICY[resources.restartPolicy],
    ...(resources.cpuLimit !== null && { NanoCpus: Math.round(resources.cpuLimit * 1e9) }),
    // MemorySwap = Memory: no swap, so the limit is the limit.
    ...(memoryBytes !== undefined && { Memory: memoryBytes, MemorySwap: memoryBytes }),
  };
}

function optionalNumber(value: string | undefined): number | null {
  const number = Number(value);
  return value === undefined || !Number.isInteger(number) || number <= 0 ? null : number;
}

function dockerStatusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode;
}

function isDockerNotFound(error: unknown): boolean {
  return dockerStatusCode(error) === 404;
}
