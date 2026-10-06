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
  type StartedContainer,
  type ContainerStats,
} from "../docker/DockerService.js";
import type { LogChunk } from "../docker/logs.js";
import { buildContainerName, replicaContainerName } from "../docker/naming.js";
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
  | "ensureVolume"
  | "deploymentContainers"
  | "containerStats"
  | "ensureImage"
  | "prepareVolumeOwnership"
  | "removeVolume"
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
      hostPorts: [],
      replicas: 1,
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
    /** Containers started for this run, to stop if it fails. */
    const startedContainers: string[] = [];

    try {
      const service = job.service;
      const prebuilt = service?.image ?? null;
      const env = job.env ?? { runtime: {}, build: {} };
      const worker = service?.type === "WORKER";
      const healthCheck = job.healthCheck ?? DEFAULT_HEALTH_CHECK;
      let command: string[] | undefined;

      if (prebuilt) {
        // A prebuilt image (a database): nothing to clone, detect or build. The
        // statuses still advance in order, so history reads the same.
        await moveTo(DeploymentStatus.CLONING);
        log("system", `Runs the prebuilt image ${prebuilt.name}: nothing to clone or build\n`);
        await moveTo(DeploymentStatus.DETECTING);
        log("system", describeEnvironment(env));
        state.imageName = prebuilt.name;
        state.containerPort = service!.port;
        await moveTo(DeploymentStatus.BUILDING);
        await this.deps.docker.ensureImage(prebuilt.name, (text) => log("build", text));
      } else {
        // 1. Clone
        await moveTo(DeploymentStatus.CLONING);
        workspacePath = await this.deps.workspace.prepare(job.id);
        const source = await this.deps.source.clone(job.repository, workspacePath, job.branch);
        state.commitSha = source.commitSha;
        log("system", `Cloned ${job.repository.cloneUrl} at ${source.commitSha.slice(0, 7)}\n`);

        // 2. Detect: the repository's own Dockerfile, or one generated for the detected language and framework.
        await moveTo(DeploymentStatus.DETECTING);
        const serviceDir = await resolveSourceDir(source.path, service?.sourceDir ?? ".");
        const plan = await prepareBuild(
          serviceDir,
          (text) => log("system", text),
          Object.keys(env.build).sort(),
          { buildCommand: service?.buildCommand, startCommand: service?.startCommand, port: service?.port },
          { repositoryDir: source.path },
        );
        const buildDir = plan.contextDir;
        log("system", describeEnvironment(env));
        state.containerPort = worker ? null : plan.containerPort;
        command = plan.command;

        // 3. Build
        await moveTo(DeploymentStatus.BUILDING);
        await this.deps.docker.buildImage(
          buildDir,
          state.imageName,
          this.labelsFor(job, state.containerPort, healthCheck),
          (text) => log("build", text),
          plan.dockerfile,
          env.build,
        );
        await this.deps.registry.publish(state.imageName, (text) => log("build", text));
        // Source is baked into the image now; the clone is no longer needed.
        await this.deps.workspace.cleanup(workspacePath);
        workspacePath = null;
      }
      const labels = {
        ...this.labelsFor(job, state.containerPort, healthCheck),
        ...(prebuilt && { [ShipyardLabel.HEALTH_KIND]: "docker" }),
      };

      // 4. Start
      await moveTo(DeploymentStatus.STARTING);
      if (job.resources) log("system", describeResources(job.resources));
      const routed = !worker && (service?.public ?? true);
      if (service) await this.deps.docker.ensureNetwork(service.network, { [ShipyardLabel.PROJECT_ID]: job.labels?.[ShipyardLabel.PROJECT_ID] ?? "" });
      for (const volume of job.volumes ?? []) {
        if (await this.deps.docker.ensureVolume(volume.name, { [ShipyardLabel.PROJECT_ID]: job.labels?.[ShipyardLabel.PROJECT_ID] ?? "", "shipyard.volume.mount": volume.mountPath })) {
          await this.deps.docker.prepareVolumeOwnership(volume.name, state.imageName, volume.mountPath);
          log("system", `Created volume ${volume.name} at ${volume.mountPath}\n`);
        }
      }
      // Every replica is the same container under its own name; replica 1 is the deployment's own.
      const replicas = job.replicas ?? 1;
      state.replicas = replicas;
      const startReplica = async (replica: number) => {
        const container = await this.deps.docker.createAndStartContainer({
          volumes: job.volumes,
          imageName: state.imageName,
          containerName: replicaContainerName(state.containerName, replica),
          // A prebuilt service is reached by name on the project network only: nothing is published.
          containerPort: prebuilt ? null : state.containerPort,
          labels: { ...labels, [ShipyardLabel.REPLICA]: String(replica) },
          network: routed ? this.deps.router.network : null,
          privateNetwork: service ? { name: service.network, alias: service.alias } : null,
          command,
          env: { ...env.runtime, ...service?.environment },
          healthCheckPort: prebuilt ? null : healthCheck.port,
          resources: job.resources,
          ...(prebuilt && { healthCommand: prebuilt.healthCommand }),
        });
        startedContainers.push(container.id);
        if (container.hostPort !== null) state.hostPorts.push(container.hostPort);
        return container;
      };
      const checkReplica = async (container: StartedContainer, replica: number) => {
        const which = replicas > 1 ? ` (replica ${replica}/${replicas})` : "";
        if (prebuilt) {
          const seconds = await this.waitDockerHealthy(container.id, healthCheck.timeoutMs);
          log("system", `Ready: ${prebuilt.healthCommand[0]} succeeded after ${seconds}s${which}\n`);
        } else if (worker) {
          await this.waitWorkerSettles(container.id);
          log("system", `Worker kept running for ${Math.round(this.workerSettleMs / 1000)}s${which}\n`);
        } else {
          const health = await this.deps.healthCheck.waitUntilHealthy({
            ...healthCheckTarget(container.healthHostPort!, healthCheck),
            getContainerState: () => this.deps.docker.getContainerState(container.id),
          });
          log("system", `Health check passed (HTTP ${health.statusCode} after ${health.attempts} attempt(s))${which}\n`);
        }
      };

      const first = await startReplica(1);
      state.containerId = first.id;
      state.hostPort = first.hostPort;

      // 5. Health check: HTTP for web services; for workers, that the process keeps running.
      //    Replicas are started and checked one at a time: a bad version fails at the first
      //    one, before the rest are started, and never receives traffic.
      await moveTo(DeploymentStatus.HEALTH_CHECKING);
      await checkReplica(first, 1);
      for (let replica = 2; replica <= replicas; replica += 1) {
        log("system", `Starting replica ${replica}/${replicas}\n`);
        await checkReplica(await startReplica(replica), replica);
      }
      await moveTo(DeploymentStatus.HEALTHY);

      // 6. Route: move the address to this container. Resolves only once visitors
      //    actually reach it; until then the previous deployment keeps serving.
      await moveTo(DeploymentStatus.ROUTING);
      const routeName = job.routeName ?? job.name;
      if (routed) {
        const url = this.deps.router.urlFor(routeName, first.hostPort!);
        await this.deps.router.activate({
          name: routeName,
          aliases: job.domains,
          deploymentId: job.id,
          containerName: state.containerName,
          containerPort: state.containerPort!,
          hostPorts: state.hostPorts,
          ...replicaRouting(state.containerName, replicas, healthCheck),
        });
        state.deploymentUrl = url;
        log("system", `Live at ${url}\n`);
      } else if (service) {
        log(
          "system",
          worker
            ? `Running (workers aren't routed)\n`
            : prebuilt
              ? `Running, private: reachable inside the project at ${service.alias}:${state.containerPort}\n`
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

      if (startedContainers.length > 0) {
        // The last one started is the one that failed (or the only one).
        await this.reportRuntimeLogs(startedContainers.at(-1)!, log, logger);
        // Stop — but keep — the broken containers so their logs remain inspectable.
        for (const id of startedContainers) {
          await this.deps.docker
            .stopContainer(id)
            .catch((stopError: unknown) => logger.warn({ err: stopError }, "Could not stop failed container"));
        }
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

  /** Stops every replica of the deployment. Idempotent: stopping an already-stopped container succeeds. */
  async stop(containerReference: string): Promise<ContainerActionResult> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    const ids = container.deploymentId ? await this.deps.docker.deploymentContainers(container.deploymentId) : [];
    for (const id of ids.length > 0 ? ids : [container.id]) {
      const replica = id === container.id ? container : await this.deps.docker.inspectManagedContainer(id);
      if (replica.running) await this.deps.docker.stopContainer(replica.id);
    }
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
    // Every replica, in order: one at a time, each checked before the next.
    const ids = before.deploymentId ? await this.deps.docker.deploymentContainers(before.deploymentId) : [];
    const replicaIds = ids.length > 0 ? ids : [before.id];

    const first = await this.restartReplica(replicaIds[0]!);
    // Checked the way it was when deployed (its labels), not with today's project settings.
    await onStage(DeploymentStatus.HEALTH_CHECKING);
    await this.checkRestarted(first);
    const containers = [first];
    for (const id of replicaIds.slice(1)) {
      const replica = await this.restartReplica(id);
      await this.checkRestarted(replica);
      containers.push(replica);
    }
    await onStage(DeploymentStatus.HEALTHY);

    await onStage(DeploymentStatus.ROUTING);
    if (route) {
      for (const container of containers) await this.joinRouterNetwork(container);
      await this.deps.router.activate({
        name: route.name,
        aliases: route.aliases,
        deploymentId: first.deploymentId ?? first.id,
        containerName: first.name,
        containerPort: first.containerPort,
        hostPorts: containers.map((container) => container.hostPort).filter((port) => port !== null),
        ...replicaRouting(first.name, containers.length, first.healthCheck),
      });
    }

    return {
      containerName: first.name,
      status: DeploymentStatus.RUNNING,
      hostPort: first.hostPort,
      deploymentUrl: route && first.hostPort !== null ? this.deps.router.urlFor(route.name, first.hostPort) : null,
    };
  }

  /** `docker restart`, then waits for its published port to come back. */
  private async restartReplica(containerId: string): Promise<ManagedContainer> {
    const before = await this.deps.docker.inspectManagedContainer(containerId);
    await this.deps.docker.restartContainer(before.id);
    // Workers and Docker-checked services publish nothing.
    const unpublished = before.containerPort === 0 || before.dockerHealthCheck;

    // Docker may assign a different ephemeral host port after a restart, and
    // can report no port at all for a moment while it re-publishes them.
    let after = await this.deps.docker.inspectManagedContainer(before.id);
    for (
      let attempt = 0;
      !unpublished && attempt < 20 && after.running && (after.hostPort === null || after.healthHostPort === null);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      after = await this.deps.docker.inspectManagedContainer(before.id);
    }
    if (!unpublished && (after.hostPort === null || after.healthHostPort === null)) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, "Container restarted without a published port.");
    }
    return after;
  }

  private async checkRestarted(container: ManagedContainer): Promise<void> {
    if (container.dockerHealthCheck) {
      await this.waitDockerHealthy(container.id, container.healthCheck.timeoutMs);
    } else if (container.containerPort === 0) {
      await this.waitWorkerSettles(container.id);
    } else {
      await this.deps.healthCheck.waitUntilHealthy({
        ...healthCheckTarget(container.healthHostPort!, container.healthCheck),
        getContainerState: () => this.deps.docker.getContainerState(container.id),
      });
    }
  }

  /**
   * Makes sure the router can reach an existing container. Containers started
   * before routing was turned on are not on its network yet.
   */
  async ensureRoutable(containerReference: string): Promise<void> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    const ids = container.deploymentId ? await this.deps.docker.deploymentContainers(container.deploymentId) : [];
    for (const id of ids.length > 0 ? ids : [container.id]) {
      await this.joinRouterNetwork(id === container.id ? container : await this.deps.docker.inspectManagedContainer(id));
    }
  }

  /** Resource use of a deployment: one sample per replica. */
  async stats(containerReference: string): Promise<ContainerStats[]> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    const ids = container.deploymentId ? await this.deps.docker.deploymentContainers(container.deploymentId) : [];
    const samples: ContainerStats[] = [];
    for (const id of ids.length > 0 ? ids : [container.id]) samples.push(await this.deps.docker.containerStats(id));
    return samples;
  }

  /** Current container state, for reconciling stored status with reality. */
  async inspect(
    containerReference: string,
  ): Promise<{ running: boolean; exitCode: number | null; hostPort: number | null }> {
    const container = await this.deps.docker.inspectManagedContainer(containerReference);
    return { running: container.running, exitCode: container.exitCode, hostPort: container.hostPort };
  }

  /** Deletes volumes and their data, after the containers using them are gone. */
  async removeVolumes(names: readonly string[]): Promise<void> {
    for (const name of names) await this.deps.docker.removeVolume(name);
  }

  /** Removes a project's private network (after its containers are gone). */
  async removeNetwork(name: string): Promise<void> {
    await this.deps.docker.removeNetwork(name);
  }

  /** Removes a deployment's container and image. Missing artifacts are ignored. */
  async destroy(artifacts: { deploymentId?: string; containerId: string | null; imageName: string | null }): Promise<void> {
    const replicas = artifacts.deploymentId ? await this.deps.docker.deploymentContainers(artifacts.deploymentId) : [];
    for (const id of new Set([...(artifacts.containerId ? [artifacts.containerId] : []), ...replicas])) {
      await this.deps.docker.removeContainer(id);
    }
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
  /**
   * Waits for Docker's own health check (the image's command, e.g. pg_isready)
   * to pass. Returns the seconds it took. Fails if the container stops, Docker
   * reports it unhealthy, or `timeoutMs` (default 2 minutes) passes.
   */
  private async waitDockerHealthy(containerId: string, timeoutMs: number | null): Promise<number> {
    const started = Date.now();
    const limit = timeoutMs ?? 120_000;
    while (true) {
      const state = await this.deps.docker.getContainerState(containerId);
      if (state.health === "healthy") return Math.max(1, Math.round((Date.now() - started) / 1000));
      if (!state.running) {
        const how = state.oomKilled ? " because it ran out of memory" : state.exitCode === null ? "" : ` with code ${state.exitCode}`;
        throw new AppError(ErrorCode.HEALTH_CHECK_FAILED, `The container exited${how} before it was ready.`, { statusCode: 422 });
      }
      if (state.health === "unhealthy") {
        throw new AppError(ErrorCode.HEALTH_CHECK_FAILED, "Docker reports the container unhealthy: its readiness check keeps failing.", {
          statusCode: 422,
        });
      }
      if (Date.now() - started >= limit) {
        throw new AppError(ErrorCode.HEALTH_CHECK_FAILED, `Not ready within ${Math.round(limit / 1000)}s.`, { statusCode: 422 });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

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

/**
 * The other replicas' container names, and, with several replicas and an
 * explicitly configured health path, a check the proxy runs on each replica.
 * ("/" is not checked by the proxy: many apps answer it with 404, which the
 * proxy would count as down.)
 */
export function replicaRouting(
  containerName: string,
  replicas: number,
  health: HealthCheckSettings,
): { replicaContainers: string[]; healthCheck?: { path: string; port: number | null } } {
  const replicaContainers = Array.from({ length: replicas - 1 }, (_, index) => replicaContainerName(containerName, index + 2));
  return {
    replicaContainers,
    ...(replicas > 1 && health.path !== "/" && { healthCheck: { path: health.path, port: health.port } }),
  };
}
