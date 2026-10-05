import { AppError, ErrorCode, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { DEFAULT_CONTAINER_PORT, detectDockerfile } from "../detection/dockerfile.js";
import { type DockerService, ShipyardLabel } from "../docker/DockerService.js";
import type { LogChunk } from "../docker/logs.js";
import { buildContainerName, buildImageName } from "../docker/naming.js";
import type { SourceProvider } from "../git/GitService.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { HealthCheckService } from "./HealthCheckService.js";
import { DeploymentStatus, assertTransition } from "./status.js";
import type {
  ContainerActionResult,
  DeploymentJob,
  DeploymentLogSource,
  DeploymentObserver,
  DeploymentState,
} from "./types.js";

/** The subset of DockerService the engine uses — keeps tests honest about dependencies. */
export type EngineDocker = Pick<
  DockerService,
  | "buildImage"
  | "createAndStartContainer"
  | "inspectManagedContainer"
  | "getContainerState"
  | "getLogs"
  | "stopContainer"
  | "restartContainer"
  | "removeContainer"
  | "removeImage"
>;

export interface DeploymentEngineDeps {
  source: SourceProvider;
  docker: EngineDocker;
  healthCheck: Pick<HealthCheckService, "waitUntilHealthy">;
  workspace: Pick<WorkspaceService, "prepare" | "cleanup">;
  logger: Logger;
}

/** Thrown when a run fails after it started; carries the final state. */
export class DeploymentFailedError extends AppError {
  constructor(
    readonly deployment: Readonly<DeploymentState>,
    cause: unknown,
  ) {
    const code = cause instanceof AppError ? cause.code : ErrorCode.INTERNAL_ERROR;
    super(code, deployment.errorMessage ?? "Deployment failed.", { statusCode: 422, cause });
  }
}

const FAILURE_LOG_TAIL = 50;

/**
 * The mechanics of a deployment: clone → detect → build → start → health check.
 *
 * It enforces the status order for ONE run and reports progress to an observer.
 * It knows nothing about the database, projects, or which other deployments
 * exist — those policies live in modules/deployments/DeploymentService.
 * Input must already be validated (see parseRepositoryUrl / validateBranchName).
 */
export class DeploymentEngine {
  constructor(private readonly deps: DeploymentEngineDeps) {}

  /** Image and container names are deterministic, so callers can know them up front. */
  static artifactNames(job: Pick<DeploymentJob, "id" | "name">): { imageName: string; containerName: string } {
    return { imageName: buildImageName(job.name, job.id), containerName: buildContainerName(job.name, job.id) };
  }

  async run(job: DeploymentJob, observer: DeploymentObserver = {}): Promise<DeploymentState> {
    const state: DeploymentState = {
      id: job.id,
      status: DeploymentStatus.PENDING,
      branch: job.branch,
      commitSha: null,
      ...DeploymentEngine.artifactNames(job),
      containerId: null,
      containerPort: null,
      hostPort: null,
      deploymentUrl: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
    };

    const log = (source: DeploymentLogSource, text: string) => observer.onLog?.(source, text);
    const moveTo = (status: DeploymentStatus) => this.transition(state, status, observer);
    const logger = this.deps.logger.child({ deploymentId: job.id });

    let workspacePath: string | null = null;

    try {
      // 1. Clone
      await moveTo(DeploymentStatus.CLONING);
      workspacePath = await this.deps.workspace.prepare(job.id);
      const source = await this.deps.source.clone(job.repository, workspacePath, job.branch);
      state.commitSha = source.commitSha;
      log("system", `Cloned ${job.repository.cloneUrl} at ${source.commitSha.slice(0, 7)}\n`);

      // 2. Detect
      const dockerfile = await detectDockerfile(source.path);
      if (!dockerfile) {
        throw new AppError(
          ErrorCode.DOCKERFILE_NOT_FOUND,
          "No Dockerfile found at the repository root. (Automatic Dockerfile generation for Node.js projects is planned.)",
          { statusCode: 422 },
        );
      }
      state.containerPort = dockerfile.exposedPort ?? DEFAULT_CONTAINER_PORT;
      log(
        "system",
        dockerfile.exposedPort === null
          ? `Dockerfile has no EXPOSE; assuming port ${state.containerPort}\n`
          : `Dockerfile exposes port ${state.containerPort}\n`,
      );

      // 3. Build
      await moveTo(DeploymentStatus.BUILDING);
      const labels = this.labelsFor(job, state.containerPort);
      await this.deps.docker.buildImage(source.path, state.imageName, labels, (text) => log("build", text));
      // Source is baked into the image now; the clone is no longer needed.
      await this.deps.workspace.cleanup(workspacePath);
      workspacePath = null;

      // 4. Start
      await moveTo(DeploymentStatus.STARTING);
      const container = await this.deps.docker.createAndStartContainer({
        imageName: state.imageName,
        containerName: state.containerName,
        containerPort: state.containerPort,
        labels,
      });
      state.containerId = container.id;
      state.hostPort = container.hostPort;

      // 5. Health check
      const health = await this.deps.healthCheck.waitUntilHealthy({
        url: healthCheckUrl(container.hostPort),
        getContainerState: () => this.deps.docker.getContainerState(container.id),
      });
      log("system", `Health check passed (HTTP ${health.statusCode} after ${health.attempts} attempt(s))\n`);
      await moveTo(DeploymentStatus.HEALTHY);

      // 6. Route. Today: the published host port. Milestone "Traefik": a stable hostname.
      state.deploymentUrl = publicUrl(container.hostPort);
      await moveTo(DeploymentStatus.RUNNING);

      logger.info({ url: state.deploymentUrl, commitSha: state.commitSha }, "Deployment running");
      return state;
    } catch (error) {
      state.errorMessage = errorMessage(error);
      if (error instanceof AppError) {
        // Expected failure (bad repo, build error, crash): no stack trace needed.
        logger.warn({ code: error.code, status: state.status, reason: error.message }, "Deployment failed");
      } else {
        logger.error({ err: error, status: state.status }, "Deployment failed unexpectedly");
      }
      log("system", `ERROR: ${state.errorMessage}\n`);

      if (state.containerId) {
        await this.reportRuntimeLogs(state.containerId, log, logger);
        // Stop — but keep — the broken container so its logs remain inspectable.
        await this.deps.docker
          .stopContainer(state.containerId)
          .catch((stopError: unknown) => logger.warn({ err: stopError }, "Could not stop failed container"));
      }

      await moveTo(DeploymentStatus.FAILED);
      throw new DeploymentFailedError(state, error);
    } finally {
      if (workspacePath !== null) {
        await this.deps.workspace
          .cleanup(workspacePath)
          .catch((cleanupError: unknown) => logger.warn({ err: cleanupError }, "Could not clean up workspace"));
      }
    }
  }

  async getLogs(containerReference: string, tail?: number): Promise<LogChunk[]> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    return this.deps.docker.getLogs(container.id, tail);
  }

  /** Idempotent: stopping an already-stopped container succeeds. */
  async stop(containerReference: string): Promise<ContainerActionResult> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    if (container.running) await this.deps.docker.stopContainer(container.id);
    return { containerName: container.name, status: DeploymentStatus.STOPPED, hostPort: null, deploymentUrl: null };
  }

  /** Restarts the container and waits until it is healthy again. */
  async restart(containerReference: string): Promise<ContainerActionResult> {
    const before = await this.deps.docker.inspectManagedContainer(containerReference);
    await this.deps.docker.restartContainer(before.id);

    // Docker may assign a different ephemeral host port after a restart.
    const after = await this.deps.docker.inspectManagedContainer(before.id);
    if (after.hostPort === null) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, "Container restarted without a published port.");
    }

    await this.deps.healthCheck.waitUntilHealthy({
      url: healthCheckUrl(after.hostPort),
      getContainerState: () => this.deps.docker.getContainerState(after.id),
    });

    return {
      containerName: after.name,
      status: DeploymentStatus.RUNNING,
      hostPort: after.hostPort,
      deploymentUrl: publicUrl(after.hostPort),
    };
  }

  /** Current container state, for reconciling stored status with reality. */
  async inspect(
    containerReference: string,
  ): Promise<{ running: boolean; exitCode: number | null; hostPort: number | null; deploymentUrl: string | null }> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    return {
      running: container.running,
      exitCode: container.exitCode,
      hostPort: container.hostPort,
      deploymentUrl: container.hostPort === null ? null : publicUrl(container.hostPort),
    };
  }

  /** Removes a deployment's container and image. Missing artifacts are ignored. */
  async destroy(artifacts: { containerId: string | null; imageName: string | null }): Promise<void> {
    if (artifacts.containerId) await this.deps.docker.removeContainer(artifacts.containerId);
    if (artifacts.imageName) await this.deps.docker.removeImage(artifacts.imageName);
  }

  private async transition(
    state: DeploymentState,
    to: DeploymentStatus,
    observer: DeploymentObserver,
  ): Promise<void> {
    const previous = state.status;
    assertTransition(previous, to);
    state.status = to;

    if (to === DeploymentStatus.CLONING) state.startedAt = new Date();
    if (to === DeploymentStatus.RUNNING || to === DeploymentStatus.FAILED) state.finishedAt = new Date();

    await observer.onStatusChange?.(state, previous);
  }

  private labelsFor(job: DeploymentJob, containerPort: number): Record<string, string> {
    return {
      ...job.labels,
      [ShipyardLabel.MANAGED]: "true",
      [ShipyardLabel.DEPLOYMENT_ID]: job.id,
      [ShipyardLabel.REPOSITORY]: job.repository.cloneUrl,
      [ShipyardLabel.CONTAINER_PORT]: String(containerPort),
    };
  }

  private async reportRuntimeLogs(
    containerId: string,
    log: (source: DeploymentLogSource, text: string) => void,
    logger: Logger,
  ): Promise<void> {
    try {
      const chunks = await this.deps.docker.getLogs(containerId, FAILURE_LOG_TAIL);
      for (const chunk of chunks) log("runtime", chunk.text);
    } catch (logError) {
      logger.warn({ err: logError }, "Could not read logs of failed container");
    }
  }
}

// Published ports are bound to 127.0.0.1 or 0.0.0.0; either way, loopback reaches them.
function healthCheckUrl(hostPort: number): string {
  return `http://127.0.0.1:${hostPort}/`;
}

function publicUrl(hostPort: number): string {
  return `http://localhost:${hostPort}`;
}
