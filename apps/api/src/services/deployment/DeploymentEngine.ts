import fs from "node:fs/promises";
import path from "node:path";

import { AppError, ErrorCode, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { prepareBuild } from "../build/prepareBuild.js";
import {
  type ContainerResources,
  type DockerService,
  type HealthCheckSettings,
  type ManagedContainer,
  ShipyardLabel,
} from "../docker/DockerService.js";
import type { LogChunk } from "../docker/logs.js";
import { buildContainerName } from "../docker/naming.js";
import type { ImageRegistry } from "../registry/ImageRegistry.js";
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
  | "followLogs"
  | "stopContainer"
  | "restartContainer"
  | "connectToNetwork"
  | "ensureNetwork"
  | "removeNetwork"
  | "removeContainer"
  | "removeImage"
>;

export interface DeploymentEngineDeps {
  source: SourceProvider;
  docker: EngineDocker;
  healthCheck: Pick<HealthCheckService, "waitUntilHealthy">;
  workspace: Pick<WorkspaceService, "prepare" | "cleanup">;
  router: Router;
  registry: ImageRegistry;
  logger: Logger;
  /** How long a new worker must keep running to count as healthy. Default 10s. */
  workerSettleMs?: number;
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
  private readonly workerSettleMs: number;

  constructor(private readonly deps: DeploymentEngineDeps) {
    this.workerSettleMs = deps.workerSettleMs ?? 10_000;
  }

  /** Image and container names are deterministic, so callers can know them up front. */
  artifactNames(job: Pick<DeploymentJob, "id" | "name">): { imageName: string; containerName: string } {
    return { imageName: this.deps.registry.imageName(job.name, job.id), containerName: buildContainerName(job.name, job.id) };
  }

  async run(job: DeploymentJob, observer: DeploymentObserver = {}): Promise<DeploymentState> {
    const state: DeploymentState = {
      id: job.id,
      status: DeploymentStatus.QUEUED,
      branch: job.branch,
      commitSha: null,
      ...this.artifactNames(job),
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
      const service = job.service;
      const buildDir = await resolveSourceDir(source.path, service?.sourceDir ?? ".");
      const env = job.env ?? { runtime: {}, build: {} };
      const plan = await prepareBuild(buildDir, (text) => log("system", text), Object.keys(env.build).sort(), {
        buildCommand: service?.buildCommand,
        startCommand: service?.startCommand,
        port: service?.port,
      });
      log("system", describeEnvironment(env));
      const worker = service?.type === "WORKER";
      state.containerPort = worker ? null : plan.containerPort;

      // 3. Build
      await moveTo(DeploymentStatus.BUILDING);
      const healthCheck = job.healthCheck ?? DEFAULT_HEALTH_CHECK;
      const labels = this.labelsFor(job, state.containerPort, healthCheck);
      await this.deps.docker.buildImage(
        buildDir,
        state.imageName,
        labels,
        (text) => log("build", text),
        plan.dockerfile,
        env.build,
      );
      await this.deps.registry.publish(state.imageName, (text) => log("build", text));
      // Source is baked into the image now; the clone is no longer needed.
      await this.deps.workspace.cleanup(workspacePath);
      workspacePath = null;

      // 4. Start
      await moveTo(DeploymentStatus.STARTING);
      if (job.resources) log("system", describeResources(job.resources));
      const routed = !worker && (service?.public ?? true);
      if (service) await this.deps.docker.ensureNetwork(service.network, { [ShipyardLabel.PROJECT_ID]: job.labels?.[ShipyardLabel.PROJECT_ID] ?? "" });
      const container = await this.deps.docker.createAndStartContainer({
        imageName: state.imageName,
        containerName: state.containerName,
        containerPort: state.containerPort,
        labels,
        network: routed ? this.deps.router.network : null,
        privateNetwork: service ? { name: service.network, alias: service.alias } : null,
        command: plan.command,
        env: env.runtime,
        healthCheckPort: healthCheck.port,
        resources: job.resources,
      });
      state.containerId = container.id;
      state.hostPort = container.hostPort;

      // 5. Health check: HTTP for web services; for workers, that the process keeps running.
      await moveTo(DeploymentStatus.HEALTH_CHECKING);
      if (worker) {
        await this.waitWorkerSettles(container.id);
        log("system", `Worker kept running for ${Math.round(this.workerSettleMs / 1000)}s\n`);
      } else {
        const health = await this.deps.healthCheck.waitUntilHealthy({
          ...healthCheckTarget(container.healthHostPort!, healthCheck),
          getContainerState: () => this.deps.docker.getContainerState(container.id),
        });
        log("system", `Health check passed (HTTP ${health.statusCode} after ${health.attempts} attempt(s))\n`);
      }
      await moveTo(DeploymentStatus.HEALTHY);

      // 6. Route: move the address to this container. Resolves only once visitors
      //    actually reach it; until then the previous deployment keeps serving.
      await moveTo(DeploymentStatus.ROUTING);
      const routeName = job.routeName ?? job.name;
      if (routed) {
        const url = this.deps.router.urlFor(routeName, container.hostPort!);
        await this.deps.router.activate({
          name: routeName,
          aliases: job.domains,
          deploymentId: job.id,
          containerName: state.containerName,
          containerPort: state.containerPort!,
        });
        state.deploymentUrl = url;
        log("system", `Live at ${url}\n`);
      } else if (service) {
        log(
          "system",
          worker
            ? `Running (workers aren't routed)\n`
            : `Running, private: reachable inside the project at http://${service.alias}:${state.containerPort}\n`,
        );
      }
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

  /** Follows a Shipyard container's output until it stops or `signal` aborts. */
  async followLogs(
    containerReference: string,
    tail: number,
    onChunk: (chunk: LogChunk) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    await this.deps.docker.followLogs(container.id, tail, onChunk, signal);
  }

  /** Idempotent: stopping an already-stopped container succeeds. */
  async stop(containerReference: string): Promise<ContainerActionResult> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    if (container.running) await this.deps.docker.stopContainer(container.id);
    return { containerName: container.name, status: DeploymentStatus.STOPPED, hostPort: null, deploymentUrl: null };
  }

  /**
   * Restarts the container, waits until it is healthy again, then points the
   * route at it. Restarting an older deployment is a rollback.
   * `onStage` is told when the health check starts, passes, and routing starts,
   * so the caller can record each stage as it happens.
   */
  async restart(
    containerReference: string,
    /** null = not routed (a worker or a private service): it just runs again. */
    route: { name: string; aliases?: readonly string[] } | null,
    onStage: (status: DeploymentStatus) => Promise<void> = async () => {},
  ): Promise<ContainerActionResult> {
    const before = await this.deps.docker.inspectManagedContainer(containerReference);
    await this.deps.docker.restartContainer(before.id);
    const worker = before.containerPort === 0;

    // Docker may assign a different ephemeral host port after a restart, and
    // can report no port at all for a moment while it re-publishes them.
    let after = await this.deps.docker.inspectManagedContainer(before.id);
    for (
      let attempt = 0;
      !worker && attempt < 20 && after.running && (after.hostPort === null || after.healthHostPort === null);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      after = await this.deps.docker.inspectManagedContainer(before.id);
    }
    if (!worker && (after.hostPort === null || after.healthHostPort === null)) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, "Container restarted without a published port.");
    }

    // Checked the way it was when deployed (its labels), not with today's project settings.
    await onStage(DeploymentStatus.HEALTH_CHECKING);
    if (worker) {
      await this.waitWorkerSettles(after.id);
    } else {
      await this.deps.healthCheck.waitUntilHealthy({
        ...healthCheckTarget(after.healthHostPort!, after.healthCheck),
        getContainerState: () => this.deps.docker.getContainerState(after.id),
      });
    }
    await onStage(DeploymentStatus.HEALTHY);

    await onStage(DeploymentStatus.ROUTING);
    if (route) {
      await this.joinRouterNetwork(after);
      await this.deps.router.activate({
        name: route.name,
        aliases: route.aliases,
        deploymentId: after.deploymentId ?? after.id,
        containerName: after.name,
        containerPort: after.containerPort,
      });
    }

    return {
      containerName: after.name,
      status: DeploymentStatus.RUNNING,
      hostPort: after.hostPort,
      deploymentUrl: route && after.hostPort !== null ? this.deps.router.urlFor(route.name, after.hostPort) : null,
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

  /** Removes a project's private network (after its containers are gone). */
  async removeNetwork(name: string): Promise<void> {
    await this.deps.docker.removeNetwork(name);
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

  /** A worker is healthy once it has kept running for workerSettleMs; exiting earlier fails it with its exit code. */
  private async waitWorkerSettles(containerId: string): Promise<void> {
    const deadline = Date.now() + this.workerSettleMs;
    while (true) {
      const state = await this.deps.docker.getContainerState(containerId);
      if (!state.running) {
        const how = state.oomKilled ? " because it ran out of memory" : state.exitCode === null ? "" : ` with code ${state.exitCode}`;
        throw new AppError(ErrorCode.HEALTH_CHECK_FAILED, `Worker exited${how} within its first ${Math.round(this.workerSettleMs / 1000)}s.`, {
          statusCode: 422,
        });
      }
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, this.workerSettleMs)));
    }
  }

  private labelsFor(job: DeploymentJob, containerPort: number | null, health: HealthCheckSettings): Record<string, string> {
    return {
      ...job.labels,
      [ShipyardLabel.MANAGED]: "true",
      [ShipyardLabel.DEPLOYMENT_ID]: job.id,
      [ShipyardLabel.REPOSITORY]: job.repository.cloneUrl,
      // 0 = a worker (no port).
      [ShipyardLabel.CONTAINER_PORT]: String(containerPort ?? 0),
      ...(job.service && { [ShipyardLabel.SERVICE]: job.service.alias }),
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

function describeResources(resources: ContainerResources): string {
  const cpu = resources.cpuLimit === null ? "no CPU limit" : `${resources.cpuLimit} CPU`;
  const memory = resources.memoryLimitMb === null ? "no memory limit" : `${resources.memoryLimitMb} MB memory`;
  const restart = { NO: "never restarted", ON_FAILURE: "restarted after a crash (up to 5 times)", UNLESS_STOPPED: "always restarted" };
  return `Resources: ${cpu}, ${memory}, ${restart[resources.restartPolicy]}\n`;
}

/** Names only — values never reach a log. */
function describeEnvironment(env: { runtime: Record<string, string>; build: Record<string, string> }): string {
  const list = (vars: Record<string, string>) => Object.keys(vars).sort().join(", ") || "none";
  return `Environment: runtime ${list(env.runtime)}; build ${list(env.build)}\n`;
}

/**
 * The service's directory inside the clone. Validated when saved; checked again
 * here against the real files: it must stay inside the clone (no `..`, no
 * symlink pointing out) and be a directory.
 */
async function resolveSourceDir(clonePath: string, sourceDir: string): Promise<string> {
  const root = await fs.realpath(clonePath);
  const candidate = path.resolve(root, sourceDir);
  const fail = (reason: string) =>
    new AppError(ErrorCode.PROJECT_DETECTION_FAILED, `The service's directory "${sourceDir}" ${reason}.`, { statusCode: 422 });
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw fail("doesn't exist in the repository");
  }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw fail("points outside the repository");
  if (!(await fs.stat(real)).isDirectory()) throw fail("is not a directory");
  return real;
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
