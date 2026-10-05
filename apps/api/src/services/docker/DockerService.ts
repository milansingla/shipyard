import type Docker from "dockerode";
import tar from "tar-fs";

import { AppError, ErrorCode, NotFoundError, ValidationError, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { createContextFilter } from "./buildContext.js";
import { type BuildEvent, interpretBuildEvent } from "./buildOutput.js";
import { type LogChunk, demuxDockerLogs } from "./logs.js";
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
}

export interface CreateContainerOptions {
  imageName: string;
  containerName: string;
  containerPort: number;
  labels: Record<string, string>;
  /** Docker network to attach the container to (instead of the default bridge), e.g. the proxy's. */
  network?: string | null;
  /** The app's environment variables. PORT is always Shipyard's. */
  env?: Record<string, string>;
  /** A separate port to publish (loopback) for health checks. */
  healthCheckPort?: number | null;
  /** Default: no limits, never restarted by Docker. */
  resources?: ContainerResources;
}

export interface StartedContainer {
  id: string;
  hostPort: number;
  /** Where to send health checks: hostPort, or the separate health port's published port. */
  healthHostPort: number;
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

  async createAndStartContainer(options: CreateContainerOptions): Promise<StartedContainer> {
    const ports = [options.containerPort];
    if (options.healthCheckPort && options.healthCheckPort !== options.containerPort) ports.push(options.healthCheckPort);
    if (options.network) await this.assertNetworkExists(options.network);

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        Image: options.imageName,
        name: options.containerName,
        // PORT last: if a key appears twice, Docker keeps the last one.
        Env: [...Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`), `PORT=${options.containerPort}`],
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
          ...(options.network ? { NetworkMode: options.network } : {}),
          ...resourceConfig(options.resources),
          LogConfig: RUNTIME_LOG_CONFIG,
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 512,
        },
      });
      await container.start();
    } catch (error) {
      throw this.dockerError(ErrorCode.CONTAINER_START_FAILED, "Could not start container", error);
    }

    const managed = await this.inspectManagedContainer(container.id);
    if (managed.hostPort === null || managed.healthHostPort === null) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, "Docker did not assign a host port.");
    }
    return { id: container.id, hostPort: managed.hostPort, healthHostPort: managed.healthHostPort };
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

    const containerPort = Number(labels[ShipyardLabel.CONTAINER_PORT]);
    const publishedPort = (port: number): number | null => {
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
      healthHostPort: publishedPort(healthCheck.port ?? containerPort),
      networks: Object.keys(info.NetworkSettings.Networks ?? {}),
      // A crash-looping container under a restart policy reports Running *and* Restarting.
      running: info.State.Running && !info.State.Restarting,
      exitCode: info.State.Running && !info.State.Restarting ? null : info.State.ExitCode,
      oomKilled: info.State.OOMKilled === true,
    };
  }

  async getContainerState(containerId: string): Promise<ContainerState> {
    const { running, exitCode, oomKilled } = await this.inspectManagedContainer(containerId);
    return { running, exitCode, oomKilled };
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

  async stopContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).stop({ t: STOP_TIMEOUT_SECONDS });
    } catch (error) {
      // 304 = already stopped. Stopping is idempotent from our point of view.
      if (dockerStatusCode(error) === 304) return;
      throw this.dockerError(ErrorCode.DOCKER_UNAVAILABLE, "Could not stop container", error);
    }
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

  async removeImage(imageName: string): Promise<void> {
    try {
      await this.docker.getImage(imageName).remove({ force: true });
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
