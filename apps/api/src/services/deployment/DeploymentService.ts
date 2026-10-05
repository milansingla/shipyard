import { randomUUID } from "node:crypto";

import { AppError, ErrorCode, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { DEFAULT_CONTAINER_PORT, detectDockerfile } from "../detection/dockerfile.js";
import { type DockerService, ShipyardLabel } from "../docker/DockerService.js";
import type { LogChunk } from "../docker/logs.js";
import { buildContainerName, buildImageName } from "../docker/naming.js";
import { validateBranchName } from "../git/branchName.js";
import type { SourceProvider } from "../git/GitService.js";
import { parseRepositoryUrl } from "../git/repositoryUrl.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { HealthCheckService } from "./HealthCheckService.js";
import { DeploymentStatus, assertTransition } from "./status.js";
import type {
  ContainerActionResult,
  DeployRequest,
  DeploymentObserver,
  DeploymentRecord,
} from "./types.js";

/** The subset of DockerService the engine uses — keeps tests honest about dependencies. */
export type DeploymentDocker = Pick<
  DockerService,
  | "buildImage"
  | "createAndStartContainer"
  | "inspectManagedContainer"
  | "getContainerState"
  | "getLogs"
  | "stopContainer"
  | "restartContainer"
>;

export interface DeploymentServiceDeps {
  source: SourceProvider;
  docker: DeploymentDocker;
  healthCheck: Pick<HealthCheckService, "waitUntilHealthy">;
  workspace: Pick<WorkspaceService, "prepare" | "cleanup">;
  logger: Logger;
  allowedGitHosts: readonly string[];
}

/** Thrown when a deployment fails after it was created; carries the final record. */
export class DeploymentFailedError extends AppError {
  constructor(
    readonly deployment: Readonly<DeploymentRecord>,
    cause: unknown,
  ) {
    const code = cause instanceof AppError ? cause.code : ErrorCode.INTERNAL_ERROR;
    super(code, deployment.errorMessage ?? "Deployment failed.", { statusCode: 422, cause });
  }
}

const FAILURE_LOG_TAIL = 50;

/**
 * Orchestrates a deployment: clone → detect → build → start → health check → RUNNING.
 *
 * It owns the *status* of a deployment and the order of steps. It does NOT know
 * how git or Docker work — that lives in GitService and DockerService.
 */
export class DeploymentService {
  constructor(private readonly deps: DeploymentServiceDeps) {}

  async deploy(request: DeployRequest, observer: DeploymentObserver = {}): Promise<DeploymentRecord> {
    // Validate before creating anything: bad input never becomes a FAILED deployment.
    const repository = parseRepositoryUrl(request.repositoryUrl, this.deps.allowedGitHosts);
    const branch = request.branch === undefined ? null : validateBranchName(request.branch);

    const id = randomUUID();
    const record: DeploymentRecord = {
      id,
      repositoryUrl: repository.cloneUrl,
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      branch,
      commitSha: null,
      status: DeploymentStatus.PENDING,
      imageName: buildImageName(repository.name, id),
      containerId: null,
      containerName: buildContainerName(repository.name, id),
      containerPort: null,
      hostPort: null,
      deploymentUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
    };

    const log = (source: "system" | "build" | "runtime", text: string) => observer.onLog?.(source, text);
    const moveTo = (status: DeploymentStatus) => this.transition(record, status, observer);
    const logger = this.deps.logger.child({ deploymentId: id });

    let workspacePath: string | null = null;

    try {
      // 1. Clone
      moveTo(DeploymentStatus.CLONING);
      workspacePath = await this.deps.workspace.prepare(id);
      const source = await this.deps.source.clone(repository, workspacePath, branch);
      record.commitSha = source.commitSha;
      log("system", `Cloned ${repository.cloneUrl} at ${source.commitSha.slice(0, 7)}\n`);

      // 2. Detect
      const dockerfile = await detectDockerfile(source.path);
      if (!dockerfile) {
        throw new AppError(
          ErrorCode.DOCKERFILE_NOT_FOUND,
          "No Dockerfile found at the repository root. (Automatic Dockerfile generation for Node.js projects is planned.)",
          { statusCode: 422 },
        );
      }
      record.containerPort = dockerfile.exposedPort ?? DEFAULT_CONTAINER_PORT;
      log(
        "system",
        dockerfile.exposedPort === null
          ? `Dockerfile has no EXPOSE; assuming port ${record.containerPort}\n`
          : `Dockerfile exposes port ${record.containerPort}\n`,
      );

      // 3. Build
      moveTo(DeploymentStatus.BUILDING);
      const labels = this.labelsFor(record);
      await this.deps.docker.buildImage(source.path, record.imageName, labels, (text) => log("build", text));
      // Source is baked into the image now; the clone is no longer needed.
      await this.deps.workspace.cleanup(workspacePath);
      workspacePath = null;

      // 4. Start
      moveTo(DeploymentStatus.STARTING);
      const container = await this.deps.docker.createAndStartContainer({
        imageName: record.imageName,
        containerName: record.containerName,
        containerPort: record.containerPort,
        labels,
      });
      record.containerId = container.id;
      record.hostPort = container.hostPort;

      // 5. Health check
      const health = await this.deps.healthCheck.waitUntilHealthy({
        url: this.healthCheckUrl(container.hostPort),
        getContainerState: () => this.deps.docker.getContainerState(container.id),
      });
      log("system", `Health check passed (HTTP ${health.statusCode} after ${health.attempts} attempt(s))\n`);
      moveTo(DeploymentStatus.HEALTHY);

      // 6. Route. Today: the published host port. Milestone "Traefik": a stable hostname.
      record.deploymentUrl = this.publicUrl(container.hostPort);
      moveTo(DeploymentStatus.RUNNING);

      logger.info({ url: record.deploymentUrl, commitSha: record.commitSha }, "Deployment running");
      return record;
    } catch (error) {
      record.errorMessage = errorMessage(error);
      if (error instanceof AppError) {
        // Expected failure (bad repo, build error, crash): no stack trace needed.
        logger.warn({ code: error.code, status: record.status, reason: error.message }, "Deployment failed");
      } else {
        logger.error({ err: error, status: record.status }, "Deployment failed unexpectedly");
      }

      if (record.containerId) {
        await this.reportRuntimeLogs(record.containerId, log, logger);
        // Stop — but keep — the broken container so its logs remain inspectable.
        await this.deps.docker
          .stopContainer(record.containerId)
          .catch((stopError: unknown) => logger.warn({ err: stopError }, "Could not stop failed container"));
      }

      moveTo(DeploymentStatus.FAILED);
      throw new DeploymentFailedError(record, error);
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

  async stop(containerReference: string): Promise<ContainerActionResult> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    if (container.running) {
      // Without a database the current status is derived from Docker's state.
      assertTransition(DeploymentStatus.RUNNING, DeploymentStatus.STOPPING);
      await this.deps.docker.stopContainer(container.id);
    }
    return { containerName: container.name, status: DeploymentStatus.STOPPED, deploymentUrl: null };
  }

  async restart(containerReference: string): Promise<ContainerActionResult> {
    const before = await this.deps.docker.inspectManagedContainer(containerReference);
    assertTransition(before.running ? DeploymentStatus.RUNNING : DeploymentStatus.STOPPED, DeploymentStatus.STARTING);

    await this.deps.docker.restartContainer(before.id);

    // Docker may assign a different ephemeral host port after a restart.
    const after = await this.deps.docker.inspectManagedContainer(before.id);
    if (after.hostPort === null) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, "Container restarted without a published port.");
    }

    await this.deps.healthCheck.waitUntilHealthy({
      url: this.healthCheckUrl(after.hostPort),
      getContainerState: () => this.deps.docker.getContainerState(after.id),
    });

    return {
      containerName: after.name,
      status: DeploymentStatus.RUNNING,
      deploymentUrl: this.publicUrl(after.hostPort),
    };
  }

  private transition(record: DeploymentRecord, to: DeploymentStatus, observer: DeploymentObserver): void {
    const previous = record.status;
    assertTransition(previous, to);
    record.status = to;

    if (to === DeploymentStatus.CLONING) record.startedAt = new Date();
    if (to === DeploymentStatus.RUNNING || to === DeploymentStatus.FAILED) record.finishedAt = new Date();

    observer.onStatusChange?.(record, previous);
  }

  private labelsFor(record: DeploymentRecord): Record<string, string> {
    return {
      [ShipyardLabel.MANAGED]: "true",
      [ShipyardLabel.DEPLOYMENT_ID]: record.id,
      [ShipyardLabel.REPOSITORY]: record.repositoryUrl,
      [ShipyardLabel.CONTAINER_PORT]: String(record.containerPort),
    };
  }

  private async reportRuntimeLogs(
    containerId: string,
    log: (source: "runtime", text: string) => void,
    logger: Logger,
  ): Promise<void> {
    try {
      const chunks = await this.deps.docker.getLogs(containerId, FAILURE_LOG_TAIL);
      for (const chunk of chunks) log("runtime", chunk.text);
    } catch (logError) {
      logger.warn({ err: logError }, "Could not read logs of failed container");
    }
  }

  // Published ports are bound to 127.0.0.1 or 0.0.0.0; either way, loopback reaches them.
  private healthCheckUrl(hostPort: number): string {
    return `http://127.0.0.1:${hostPort}/`;
  }

  private publicUrl(hostPort: number): string {
    return `http://localhost:${hostPort}`;
  }
}
