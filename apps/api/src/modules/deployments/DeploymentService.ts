import { randomUUID } from "node:crypto";

import { type Deployment, DeploymentTrigger, type PrismaClient, type Project } from "../../db/prisma.js";
import { ConflictError, ErrorCode, NotFoundError, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { DeploymentEngine, DeploymentFailedError } from "../../services/deployment/DeploymentEngine.js";
import { DeploymentStatus, assertTransition } from "../../services/deployment/status.js";
import type { DeploymentJob, DeploymentState } from "../../services/deployment/types.js";
import { ShipyardLabel } from "../../services/docker/DockerService.js";
import { formatLogChunks } from "../../services/docker/logs.js";
import { parseRepositoryUrl } from "../../services/git/repositoryUrl.js";
import type { RouteTarget, Router } from "../../services/routing/Router.js";
import type { BuildLogStore, BuildLogWriter } from "./BuildLogStore.js";

export type EngineLike = Pick<
  DeploymentEngine,
  "run" | "stop" | "restart" | "getLogs" | "destroy" | "inspect" | "ensureRoutable"
>;

export interface DeploymentServiceDeps {
  prisma: PrismaClient;
  engine: EngineLike;
  /** The same router the engine uses: stopping takes a deployment out of it, startup rebuilds it. */
  router: Pick<Router, "urlFor" | "deactivate" | "sync">;
  buildLogs: Pick<BuildLogStore, "open" | "read" | "remove">;
  allowedGitHosts: readonly string[];
  logger: Logger;
}

export type LogType = "build" | "runtime";

/** What happened to a push-triggered deploy request. */
export type PushDeployResult =
  | { outcome: "started"; deployment: Deployment }
  /** A deploy/restart of the project was running; one follow-up deploy will run when it ends. */
  | { outcome: "queued" };

export interface DeploymentLogs {
  type: LogType;
  content: string;
  /** Set when logs are unavailable, e.g. the container was removed. */
  message?: string;
}

/** Statuses during which a deployment is still being worked on. */
const IN_PROGRESS: DeploymentStatus[] = [
  DeploymentStatus.PENDING,
  DeploymentStatus.CLONING,
  DeploymentStatus.BUILDING,
  DeploymentStatus.STARTING,
  DeploymentStatus.HEALTHY,
];

/**
 * Application-level deployment rules, on top of the engine:
 *
 * - every status change is persisted to PostgreSQL
 * - at most one deploy/restart per project at a time
 * - a new deployment only replaces the old one AFTER it is RUNNING, i.e. after
 *   the router confirmed visitors reach it (zero-downtime redeploys)
 * - deploys run in the background; the API returns immediately
 * - after a crash/restart of Shipyard, stored statuses are reconciled with Docker
 *   and the route table is rebuilt from the RUNNING deployments
 *
 * Pushes that arrive while a project is busy are coalesced: the project is
 * marked, and ONE deploy of the branch's latest commit starts when the lock is
 * released — ten quick pushes cost one extra build, not ten, and none is lost.
 * The mark is in memory (lost if Shipyard restarts mid-deploy; push again).
 *
 * Authorization: every public method takes the acting user's id and only
 * finds deployments of that user's projects; anything else is a 404.
 *
 * Concurrency note: the per-project lock is in memory, so this assumes ONE
 * Shipyard API process. Multiple instances would need a DB-level lock.
 */
export class DeploymentService {
  private readonly busyProjects = new Set<string>();
  /** Projects that received a push while busy; see deployOnPush. */
  private readonly pushWhileBusy = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: DeploymentServiceDeps) {}

  // ───────────────────────── queries ─────────────────────────

  async get(id: string, ownerId: string): Promise<Deployment> {
    const deployment = await this.deps.prisma.deployment.findFirst({ where: { id, project: { ownerId } } });
    if (!deployment) throw new NotFoundError(`Deployment not found: ${id}`);
    return deployment;
  }

  async listForProject(projectId: string, ownerId: string, limit: number): Promise<Deployment[]> {
    await this.getProject(projectId, ownerId);
    return this.deps.prisma.deployment.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async getLogs(id: string, ownerId: string, type: LogType, tail: number): Promise<DeploymentLogs> {
    const deployment = await this.get(id, ownerId);

    if (type === "build") {
      return { type, content: await this.deps.buildLogs.read(id) };
    }
    if (!deployment.containerId) {
      return { type, content: "", message: "This deployment never started a container." };
    }
    try {
      return { type, content: formatLogChunks(await this.deps.engine.getLogs(deployment.containerId, tail)) };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return { type, content: "", message: "The container no longer exists." };
      }
      throw error;
    }
  }

  // ───────────────────────── commands ─────────────────────────

  /**
   * Creates a PENDING deployment for the project's configured branch and starts
   * the pipeline in the background. Returns immediately; poll GET /deployments/:id.
   */
  async deploy(
    projectId: string,
    ownerId: string,
    trigger: DeploymentTrigger = DeploymentTrigger.MANUAL,
  ): Promise<Deployment> {
    const project = await this.getProject(projectId, ownerId);
    this.lockProject(projectId);

    let deployment: Deployment;
    try {
      const id = randomUUID();
      deployment = await this.deps.prisma.deployment.create({
        data: {
          id,
          projectId,
          trigger,
          branch: project.branch,
          ...DeploymentEngine.artifactNames({ id, name: project.slug }),
        },
      });
    } catch (error) {
      this.unlockProject(projectId);
      throw error;
    }

    this.track(this.execute(project, deployment).finally(() => this.unlockProject(projectId)));
    return deployment;
  }

  /**
   * Deploys after a GitHub push. Unlike deploy(), a busy project is not an
   * error: the push is remembered and deployed when the current work ends.
   */
  async deployOnPush(projectId: string, ownerId: string): Promise<PushDeployResult> {
    if (this.busyProjects.has(projectId)) {
      this.pushWhileBusy.add(projectId);
      return { outcome: "queued" };
    }
    return { outcome: "started", deployment: await this.deploy(projectId, ownerId, DeploymentTrigger.PUSH) };
  }

  /** Deploys the latest commit of the same project/branch as an existing deployment. */
  async redeploy(id: string, ownerId: string): Promise<Deployment> {
    const deployment = await this.get(id, ownerId);
    return this.deploy(deployment.projectId, ownerId);
  }

  async stop(id: string, ownerId: string): Promise<Deployment> {
    const deployment = await this.get(id, ownerId);
    if (deployment.status === DeploymentStatus.STOPPED) return deployment;
    return this.stopDeployment(deployment);
  }

  /**
   * Restarts a RUNNING or STOPPED deployment and waits for its health check.
   * Restarting an older, stopped deployment also retires the currently running
   * one — which makes this the rollback mechanism.
   */
  async restart(id: string, ownerId: string): Promise<Deployment> {
    const deployment = await this.get(id, ownerId);
    assertTransition(deployment.status, DeploymentStatus.STARTING);
    if (!deployment.containerId) {
      throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "This deployment has no container to restart.");
    }

    const project = await this.getProject(deployment.projectId, ownerId);
    this.lockProject(deployment.projectId);
    try {
      const starting = await this.moveTo(deployment, DeploymentStatus.STARTING);
      let result;
      try {
        result = await this.deps.engine.restart(deployment.containerId, project.slug);
      } catch (error) {
        await this.markFailed(id, error);
        throw error;
      }
      const healthy = await this.moveTo(starting, DeploymentStatus.HEALTHY);
      const running = await this.moveTo(healthy, DeploymentStatus.RUNNING, {
        hostPort: result.hostPort,
        deploymentUrl: result.deploymentUrl,
        errorMessage: null,
      });
      await this.retireOthers(deployment.projectId, id);
      return running;
    } finally {
      this.unlockProject(deployment.projectId);
    }
  }

  /**
   * Removes every container, image and log of a project, then runs `finalize`
   * (deleting the project row) while still holding the project lock, so no new
   * deployment can sneak in between.
   */
  async destroyProjectDeployments(projectId: string, finalize: () => Promise<void>): Promise<void> {
    this.lockProject(projectId);
    try {
      const deployments = await this.deps.prisma.deployment.findMany({ where: { projectId } });
      for (const deployment of deployments) {
        await this.deactivateRoute(deployment);
        // If Docker is unreachable this throws and the project is NOT deleted,
        // so no containers are orphaned. The user can simply retry.
        await this.deps.engine.destroy({ containerId: deployment.containerId, imageName: deployment.imageName });
        await this.deps.buildLogs.remove(deployment.id);
      }
      await finalize();
    } finally {
      this.unlockProject(projectId);
    }
  }

  /**
   * Called once at startup. A deploy runs inside this process, so if Shipyard
   * stopped mid-deploy its row would otherwise stay BUILDING forever.
   */
  async reconcileOnStartup(): Promise<{ failed: number; stopped: number; refreshed: number }> {
    const summary = { failed: 0, stopped: 0, refreshed: 0 };
    const { prisma, engine, logger } = this.deps;

    const interrupted = await prisma.deployment.findMany({ where: { status: { in: IN_PROGRESS } } });
    for (const deployment of interrupted) {
      if (deployment.containerId) await engine.stop(deployment.containerId).catch(() => {});
      await this.markFailed(
        deployment.id,
        `Interrupted: Shipyard stopped while this deployment was ${deployment.status}. Redeploy to try again.`,
      );
      summary.failed += 1;
    }

    const stopping = await prisma.deployment.findMany({ where: { status: DeploymentStatus.STOPPING } });
    for (const deployment of stopping) {
      if (deployment.containerId) await engine.stop(deployment.containerId).catch(() => {});
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: DeploymentStatus.STOPPED, hostPort: null, deploymentUrl: null },
      });
      summary.stopped += 1;
    }

    const running = await prisma.deployment.findMany({
      where: { status: DeploymentStatus.RUNNING },
      include: { project: { select: { slug: true } } },
    });
    for (const deployment of running) {
      const reason = await this.checkStillRunning(deployment, deployment.project.slug);
      if (reason) {
        await this.markFailed(deployment.id, reason);
        summary.failed += 1;
      } else {
        summary.refreshed += 1;
      }
    }

    await this.syncRoutes();

    if (summary.failed + summary.stopped > 0) logger.warn(summary, "Reconciled deployments after startup");
    return summary;
  }

  /** Resolves once every background deployment has finished. Used by tests and shutdown. */
  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ───────────────────────── internals ─────────────────────────

  private async execute(project: Project, deployment: Deployment): Promise<void> {
    const logger = this.deps.logger.child({ deploymentId: deployment.id, projectId: project.id });
    let writer: BuildLogWriter | null = null;

    try {
      writer = await this.deps.buildLogs.open(deployment.id);
      const logWriter = writer;
      const job: DeploymentJob = {
        id: deployment.id,
        // Re-validated on every deploy: the allowlist may have changed since creation.
        repository: parseRepositoryUrl(project.repositoryUrl, this.deps.allowedGitHosts),
        branch: deployment.branch,
        name: project.slug,
        labels: { [ShipyardLabel.PROJECT_ID]: project.id },
      };

      await this.deps.engine.run(job, {
        onStatusChange: (state) => this.persist(state),
        onLog: (source, text) => logWriter.write(source === "runtime" ? prefixLines("[app] ", text) : text),
      });

      await this.retireOthers(project.id, deployment.id);
    } catch (error) {
      // The engine already persisted FAILED for errors inside the pipeline.
      if (!(error instanceof DeploymentFailedError)) {
        logger.error({ err: error }, "Deployment crashed outside the engine");
        await this.markFailed(deployment.id, error);
      }
    } finally {
      await writer?.close().catch((closeError: unknown) => logger.warn({ err: closeError }, "Could not close build log"));
    }
  }

  private async persist(state: Readonly<DeploymentState>): Promise<void> {
    await this.deps.prisma.deployment.update({
      where: { id: state.id },
      data: {
        status: state.status,
        commitSha: state.commitSha,
        imageName: state.imageName,
        containerName: state.containerName,
        containerId: state.containerId,
        containerPort: state.containerPort,
        hostPort: state.hostPort,
        deploymentUrl: state.deploymentUrl,
        errorMessage: state.errorMessage,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
      },
    });
  }

  /** Stops every other healthy deployment of the project, keeping containers for rollback. */
  private async retireOthers(projectId: string, keepId: string): Promise<void> {
    const others = await this.deps.prisma.deployment.findMany({
      where: {
        projectId,
        id: { not: keepId },
        status: { in: [DeploymentStatus.RUNNING, DeploymentStatus.HEALTHY] },
      },
    });
    for (const other of others) {
      await this.stopDeployment(other).catch((error: unknown) =>
        this.deps.logger.warn({ err: error, deploymentId: other.id }, "Could not retire previous deployment"),
      );
    }
  }

  private async stopDeployment(deployment: Deployment): Promise<Deployment> {
    assertTransition(deployment.status, DeploymentStatus.STOPPING);
    const stopping = await this.moveTo(deployment, DeploymentStatus.STOPPING);
    try {
      // Out of the router first: visitors get a clean "not found", not errors from a stopping app.
      // A deployment being retired no longer has the route, so this is a no-op for it.
      await this.deactivateRoute(deployment);
      if (deployment.containerId) await this.deps.engine.stop(deployment.containerId);
    } catch (error) {
      // Removed outside Shipyard: it is certainly not running any more.
      if (!(error instanceof NotFoundError)) {
        await this.markFailed(deployment.id, error);
        throw error;
      }
    }
    return this.moveTo(stopping, DeploymentStatus.STOPPED, { hostPort: null, deploymentUrl: null });
  }

  /**
   * Validated, race-safe status change: the UPDATE only matches if the row is
   * still in the status we read. If something else changed it in between, the
   * update matches 0 rows and we report a conflict instead of overwriting.
   */
  private async moveTo(
    deployment: Pick<Deployment, "id" | "status">,
    to: DeploymentStatus,
    data: Partial<Pick<Deployment, "hostPort" | "deploymentUrl" | "errorMessage">> = {},
  ): Promise<Deployment> {
    assertTransition(deployment.status, to);
    const { count } = await this.deps.prisma.deployment.updateMany({
      where: { id: deployment.id, status: deployment.status },
      data: { status: to, ...data },
    });
    if (count === 0) {
      throw new ConflictError(
        ErrorCode.INVALID_STATUS_TRANSITION,
        `Deployment ${deployment.id} changed while it was being updated. Refresh and try again.`,
      );
    }
    return this.load(deployment.id);
  }

  private async markFailed(id: string, reason: unknown): Promise<void> {
    await this.deps.prisma.deployment
      .updateMany({
        where: { id, status: { not: DeploymentStatus.FAILED } },
        data: {
          status: DeploymentStatus.FAILED,
          errorMessage: typeof reason === "string" ? reason : errorMessage(reason),
          finishedAt: new Date(),
        },
      })
      .catch((error: unknown) => this.deps.logger.error({ err: error, deploymentId: id }, "Could not mark FAILED"));
  }

  /**
   * Returns a failure reason, or null if the container is still running. Refreshes
   * its port and URL (the URL changes when routing was turned on or off).
   */
  private async checkStillRunning(deployment: Deployment, slug: string): Promise<string | null> {
    if (!deployment.containerId) return "Deployment has no container.";
    try {
      const container = await this.deps.engine.inspect(deployment.containerId);
      if (!container.running) {
        return `Container exited${container.exitCode === null ? "" : ` with code ${container.exitCode}`} while Shipyard was not running.`;
      }
      // Not fatal: the app still runs; the router just can't reach it until this is fixed.
      await this.deps.engine
        .ensureRoutable(deployment.containerId)
        .catch((error: unknown) =>
          this.deps.logger.warn({ err: error, deploymentId: deployment.id }, "Router cannot reach this deployment"),
        );
      const deploymentUrl = container.hostPort === null ? null : this.deps.router.urlFor(slug, container.hostPort);
      if (container.hostPort !== deployment.hostPort || deploymentUrl !== deployment.deploymentUrl) {
        await this.deps.prisma.deployment.update({
          where: { id: deployment.id },
          data: { hostPort: container.hostPort, deploymentUrl },
        });
      }
      return null;
    } catch (error) {
      if (error instanceof NotFoundError) return "Container no longer exists.";
      throw error;
    }
  }

  /**
   * Rebuilds the router's table from the database: one route per RUNNING
   * deployment. If a project somehow has two, the most recent one wins.
   */
  private async syncRoutes(): Promise<void> {
    const running = await this.deps.prisma.deployment.findMany({
      where: { status: DeploymentStatus.RUNNING },
      include: { project: { select: { slug: true } } },
      orderBy: { finishedAt: "asc" },
    });
    const targets = new Map<string, RouteTarget>();
    for (const deployment of running) {
      if (!deployment.containerName || deployment.containerPort === null) continue;
      targets.set(deployment.project.slug, {
        name: deployment.project.slug,
        deploymentId: deployment.id,
        containerName: deployment.containerName,
        containerPort: deployment.containerPort,
      });
    }
    await this.deps.router.sync([...targets.values()]);
  }

  /** Takes the deployment out of the router, if the route still points at it. */
  private async deactivateRoute(deployment: Pick<Deployment, "id" | "projectId">): Promise<void> {
    const project = await this.deps.prisma.project.findUnique({
      where: { id: deployment.projectId },
      select: { slug: true },
    });
    if (project) await this.deps.router.deactivate(project.slug, deployment.id);
  }

  /** Unscoped: only for re-reading a row whose access was already checked. */
  private async load(id: string): Promise<Deployment> {
    const deployment = await this.deps.prisma.deployment.findUnique({ where: { id } });
    if (!deployment) throw new NotFoundError(`Deployment not found: ${id}`);
    return deployment;
  }

  private async getProject(projectId: string, ownerId: string): Promise<Project> {
    const project = await this.deps.prisma.project.findFirst({ where: { id: projectId, ownerId } });
    if (!project) throw new NotFoundError(`Project not found: ${projectId}`);
    return project;
  }

  private lockProject(projectId: string): void {
    if (this.busyProjects.has(projectId)) {
      throw new ConflictError(
        ErrorCode.DEPLOYMENT_IN_PROGRESS,
        "Another deployment or restart of this project is in progress. Wait for it to finish.",
      );
    }
    this.busyProjects.add(projectId);
  }

  private unlockProject(projectId: string): void {
    this.busyProjects.delete(projectId);
    if (this.pushWhileBusy.delete(projectId)) this.track(this.deployQueuedPush(projectId));
  }

  /** Runs the deploy a push asked for while the project was busy. */
  private async deployQueuedPush(projectId: string): Promise<void> {
    try {
      // Unscoped lookup: the push's signature was verified when it arrived; the deploy runs as the project's owner.
      const project = await this.deps.prisma.project.findUnique({ where: { id: projectId } });
      if (!project) return; // deleted in the meantime
      const result = await this.deployOnPush(project.id, project.ownerId);
      this.deps.logger.info({ projectId, outcome: result.outcome }, "Deployed a push received during a previous deploy");
    } catch (error) {
      this.deps.logger.error({ err: error, projectId }, "Could not deploy a queued push");
    }
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }
}

function prefixLines(prefix: string, text: string): string {
  return text.replace(/^(?=.)/gm, prefix);
}

