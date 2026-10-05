import path from "node:path";

import type Docker from "dockerode";
import tar from "tar-fs";

import { AppError, ErrorCode, NotFoundError, ValidationError, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
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
  REPOSITORY: "shipyard.repository",
  CONTAINER_PORT: "shipyard.container-port",
} as const;

export interface ContainerState {
  running: boolean;
  exitCode: number | null;
}

export interface ManagedContainer extends ContainerState {
  id: string;
  name: string;
  deploymentId: string | null;
  containerPort: number;
  hostPort: number | null;
}

export interface CreateContainerOptions {
  imageName: string;
  containerName: string;
  containerPort: number;
  labels: Record<string, string>;
}

export interface StartedContainer {
  id: string;
  hostPort: number;
}

interface DockerServiceOptions {
  /** Interface the container's port is published on (127.0.0.1 = local only). */
  publishHost: string;
}

const STOP_TIMEOUT_SECONDS = 10;
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
   * `onLog` receives raw build output as it streams.
   */
  async buildImage(
    contextDir: string,
    imageName: string,
    labels: Record<string, string>,
    onLog: (text: string) => void,
  ): Promise<void> {
    // The .git directory is never needed for the build and can be large.
    const context = tar.pack(contextDir, {
      ignore: (name) => path.relative(contextDir, name).split(path.sep)[0] === ".git",
    });

    let stream: NodeJS.ReadableStream;
    try {
      // tar-fs returns a streamx stream: pipe-compatible at runtime, but not typed as a Node ReadableStream.
      stream = await this.docker.buildImage(context as unknown as NodeJS.ReadableStream, {
        t: imageName,
        labels,
        rm: true,
        forcerm: true,
      });
    } catch (error) {
      throw this.dockerError(ErrorCode.DOCKER_BUILD_FAILED, "Docker refused the build request", error);
    }

    let buildError: string | null = null;

    await new Promise<void>((resolve, reject) => {
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

    if (buildError !== null) {
      throw new AppError(ErrorCode.DOCKER_BUILD_FAILED, `Docker build failed: ${buildError}`, { statusCode: 422 });
    }
  }

  async createAndStartContainer(options: CreateContainerOptions): Promise<StartedContainer> {
    const portKey = `${options.containerPort}/tcp`;

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        Image: options.imageName,
        name: options.containerName,
        Env: [`PORT=${options.containerPort}`],
        Labels: options.labels,
        ExposedPorts: { [portKey]: {} },
        HostConfig: {
          // HostPort "" = let Docker pick a free ephemeral port.
          PortBindings: { [portKey]: [{ HostIp: this.options.publishHost, HostPort: "" }] },
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 512,
        },
      });
      await container.start();
    } catch (error) {
      throw this.dockerError(ErrorCode.CONTAINER_START_FAILED, "Could not start container", error);
    }

    const managed = await this.inspectManagedContainer(container.id);
    if (managed.hostPort === null) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, "Docker did not assign a host port.");
    }
    return { id: container.id, hostPort: managed.hostPort };
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
    const binding = info.NetworkSettings.Ports?.[`${containerPort}/tcp`]?.[0];

    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ""),
      deploymentId: labels[ShipyardLabel.DEPLOYMENT_ID] ?? null,
      containerPort,
      hostPort: binding?.HostPort ? Number(binding.HostPort) : null,
      running: info.State.Running,
      exitCode: info.State.Running ? null : info.State.ExitCode,
    };
  }

  async getContainerState(containerId: string): Promise<ContainerState> {
    const { running, exitCode } = await this.inspectManagedContainer(containerId);
    return { running, exitCode };
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

  private dockerError(code: ErrorCode, message: string, cause: unknown): AppError {
    this.logger.debug({ err: cause }, message);
    return new AppError(code, `${message}: ${errorMessage(cause)}`, { cause });
  }
}

function dockerStatusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode;
}

function isDockerNotFound(error: unknown): boolean {
  return dockerStatusCode(error) === 404;
}
