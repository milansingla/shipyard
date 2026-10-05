import { AppError, ErrorCode, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { prepareBuild } from "../build/prepareBuild.js";
import {
  type DockerService,
  type HealthCheckSettings,
  type ManagedContainer,
  ShipyardLabel,
} from "../docker/DockerService.js";
import type { LogChunk } from "../docker/logs.js";
import { buildContainerName, buildImageName } from "../docker/naming.js";
import type { SourceProvider } from "../git/GitService.js";
import type { Router } from "../routing/Router.js";
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
  | "connectToNetwork"
  | "removeContainer"
  | "removeImage"
>;

export interface DeploymentEngineDeps {
  source: SourceProvider;
  docker: EngineDocker;
  healthCheck: Pick<HealthCheckService, "waitUntilHealthy">;
  workspace: Pick<WorkspaceService, "prepare" | "cleanup">;
  router: Router;
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
 * The mechanics of a deployment:
 * clone → detect (own or generated Dockerfile) → build → start → health check → route.
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
      status: DeploymentStatus.QUEUED,
      branch: job.branch,
      commitSha: null,
      ...DeploymentEngine.artifactNames(job),
      containerId: null,
      containerPort: null,
      hostPort: null,
      deploymentUrl: null,
      errorMessage: null,
      failedStage: null,
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

      // 2. Detect: the repository's own Dockerfile, or one generated for a Node.js project.
      await moveTo(DeploymentStatus.DETECTING);
      const env = job.env ?? { runtime: {}, build: {} };
      const plan = await prepareBuild(source.path, (text) => log("system", text), Object.keys(env.build).sort());
      log("system", describeEnvironment(env));
      state.containerPort = plan.containerPort;

      // 3. Build
      await moveTo(DeploymentStatus.BUILDING);
      const healthCheck = job.healthCheck ?? DEFAULT_HEALTH_CHECK;
      const labels = this.labelsFor(job, state.containerPort, healthCheck);
      await this.deps.docker.buildImage(
        source.path,
        state.imageName,
        labels,
        (text) => log("build", text),
        plan.dockerfile,
        env.build,
      );
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
        network: this.deps.router.network,
        env: env.runtime,
        healthCheckPort: healthCheck.port,
      });
      state.containerId = container.id;
      state.hostPort = container.hostPort;

      // 5. Health check
      await moveTo(DeploymentStatus.HEALTH_CHECKING);
      const health = await this.deps.healthCheck.waitUntilHealthy({
        ...healthCheckTarget(container.healthHostPort, healthCheck),
        getContainerState: () => this.deps.docker.getContainerState(container.id),
      });
      log("system", `Health check passed (HTTP ${health.statusCode} after ${health.attempts} attempt(s))\n`);
      await moveTo(DeploymentStatus.HEALTHY);

      // 6. Route: move the project's URL to this container. Resolves only once visitors
      //    actually reach it; until then the previous deployment keeps serving.
      const url = this.deps.router.urlFor(job.name, container.hostPort);
      await moveTo(DeploymentStatus.ROUTING);
      await this.deps.router.activate({
        name: job.name,
        deploymentId: job.id,
        containerName: state.containerName,
        containerPort: state.containerPort,
      });
      state.deploymentUrl = url;
      log("system", `Live at ${url}\n`);
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

      state.failedStage = state.status;
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

  /**
   * Restarts the container, waits until it is healthy again, then points the
   * route `routeName` at it. Restarting an older deployment is a rollback.
   * `onStage` is told when the health check starts, passes, and routing starts,
   * so the caller can record each stage as it happens.
   */
  async restart(
    containerReference: string,
    routeName: string,
    onStage: (status: DeploymentStatus) => Promise<void> = async () => {},
  ): Promise<ContainerActionResult> {
    const before = await this.deps.docker.inspectManagedContainer(containerReference);
    await this.deps.docker.restartContainer(before.id);

    // Docker may assign a different ephemeral host port after a restart.
    const after = await this.deps.docker.inspectManagedContainer(before.id);
    if (after.hostPort === null || after.healthHostPort === null) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, "Container restarted without a published port.");
    }
    const { hostPort, healthHostPort } = after;

    // Checked the way it was when deployed (its labels), not with today's project settings.
    await onStage(DeploymentStatus.HEALTH_CHECKING);
    await this.deps.healthCheck.waitUntilHealthy({
      ...healthCheckTarget(healthHostPort, after.healthCheck),
      getContainerState: () => this.deps.docker.getContainerState(after.id),
    });
    await onStage(DeploymentStatus.HEALTHY);

    await this.joinRouterNetwork(after);
    await onStage(DeploymentStatus.ROUTING);
    await this.deps.router.activate({
      name: routeName,
      deploymentId: after.deploymentId ?? after.id,
      containerName: after.name,
      containerPort: after.containerPort,
    });

    return {
      containerName: after.name,
      status: DeploymentStatus.RUNNING,
      hostPort,
      deploymentUrl: this.deps.router.urlFor(routeName, hostPort),
    };
  }

  /**
   * Makes sure the router can reach an existing container. Containers started
   * before routing was turned on are not on its network yet.
   */
  async ensureRoutable(containerReference: string): Promise<void> {
    await this.joinRouterNetwork(await this.deps.docker.inspectManagedContainer(containerReference));
  }

  /** Current container state, for reconciling stored status with reality. */
  async inspect(
    containerReference: string,
  ): Promise<{ running: boolean; exitCode: number | null; hostPort: number | null }> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    return { running: container.running, exitCode: container.exitCode, hostPort: container.hostPort };
  }

  /** Removes a deployment's container and image. Missing artifacts are ignored. */
  async destroy(artifacts: { containerId: string | null; imageName: string | null }): Promise<void> {
    if (artifacts.containerId) await this.deps.docker.removeContainer(artifacts.containerId);
    if (artifacts.imageName) await this.deps.docker.removeImage(artifacts.imageName);
  }

  private async joinRouterNetwork(container: ManagedContainer): Promise<void> {
    const { network } = this.deps.router;
    if (network && !container.networks.includes(network)) {
      await this.deps.docker.connectToNetwork(container.id, network);
    }
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

  private labelsFor(job: DeploymentJob, containerPort: number, health: HealthCheckSettings): Record<string, string> {
    return {
      ...job.labels,
      [ShipyardLabel.MANAGED]: "true",
      [ShipyardLabel.DEPLOYMENT_ID]: job.id,
      [ShipyardLabel.REPOSITORY]: job.repository.cloneUrl,
      [ShipyardLabel.CONTAINER_PORT]: String(containerPort),
      [ShipyardLabel.HEALTH_PATH]: health.path,
      ...(health.port !== null && { [ShipyardLabel.HEALTH_PORT]: String(health.port) }),
      ...(health.timeoutMs !== null && { [ShipyardLabel.HEALTH_TIMEOUT_MS]: String(health.timeoutMs) }),
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

/** Names only — values never reach a log. */
function describeEnvironment(env: { runtime: Record<string, string>; build: Record<string, string> }): string {
  const list = (vars: Record<string, string>) => Object.keys(vars).sort().join(", ") || "none";
  return `Environment: runtime ${list(env.runtime)}; build ${list(env.build)}\n`;
}

const DEFAULT_HEALTH_CHECK: HealthCheckSettings = { path: "/", port: null, timeoutMs: null };

/**
 * Published ports are bound to 127.0.0.1 or 0.0.0.0; either way, loopback reaches them.
 * The path was validated when it was saved; resolving it against the origin and
 * checking the origin again means it can only ever change the path, never the host.
 */
function healthCheckTarget(hostPort: number, health: HealthCheckSettings) {
  const origin = `http://127.0.0.1:${hostPort}`;
  const url = new URL(health.path, origin);
  if (url.origin !== origin) {
    throw new AppError(ErrorCode.HEALTH_CHECK_FAILED, `Invalid health check path: ${health.path}`, { statusCode: 422 });
  }
  return { url: url.href, timeoutMs: health.timeoutMs ?? undefined, strict: health.path !== "/" };
}
