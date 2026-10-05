import { randomUUID } from "node:crypto";

import {
  type Deployment,
  DeploymentEventType,
  DeploymentTrigger,
  type Prisma,
  type PrismaClient,
  type Project,
} from "../../db/prisma.js";
import { AppError, ConflictError, ErrorCode, NotFoundError, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { DeploymentEngine, DeploymentFailedError } from "../../services/deployment/DeploymentEngine.js";
import { DeploymentStatus, IN_PROGRESS_STATUSES, assertTransition } from "../../services/deployment/status.js";
import type { DeploymentJob, DeploymentState } from "../../services/deployment/types.js";
import { ShipyardLabel } from "../../services/docker/DockerService.js";
import { formatLogChunks } from "../../services/docker/logs.js";
import { parseRepositoryUrl } from "../../services/git/repositoryUrl.js";
import type { RouteTarget, Router } from "../../services/routing/Router.js";
import type { AuditService } from "../audit/AuditService.js";
import type { EnvironmentService } from "../environment/EnvironmentService.js";
import type { BuildLogStore, BuildLogWriter } from "./BuildLogStore.js";

export type EngineLike = Pick<
  DeploymentEngine,
  "run" | "stop" | "restart" | "getLogs" | "followLogs" | "destroy" | "inspect" | "ensureRoutable"
>;

export interface DeploymentServiceDeps {
  prisma: PrismaClient;
  engine: EngineLike;
  /** Decrypts the project's variables for each deployment; null = no variables (no secret key). */
  environment: Pick<EnvironmentService, "forDeployment"> | null;
  /** The same router the engine uses: stopping takes a deployment out of it, startup rebuilds it. */
  router: Pick<Router, "urlFor" | "activate" | "deactivate" | "sync">;
  buildLogs: Pick<BuildLogStore, "open" | "read" | "remove" | "follow">;
  allowedGitHosts: readonly string[];
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

export type LogType = "build" | "runtime";

/** What happened to a push-triggered deploy request. */
export type PushDeployResult =
  | { outcome: "started"; deployment: Deployment }
  /** A deploy/restart of the project was running; one follow-up deploy will run when it ends. */
  | { outcome: "queued" };

/** One entry of a deployment's history, as the API returns it. */
export interface DeploymentEventView {
  id: number;
  type: DeploymentEventType;
  fromStatus: DeploymentStatus | null;
  toStatus: DeploymentStatus | null;
  /** Login of the person who caused it; null when Shipyard acted on its own. */
  actor: string | null;
  message: string | null;
  createdAt: Date;
}

/** Who caused a status change, and why. Recorded with it. */
interface Cause {
  actorId?: string | null;
  message?: string | null;
}

export interface DeploymentLogs {
  type: LogType;
  content: string;
  /** Set when logs are unavailable, e.g. the container was removed. */
  message?: string;
}

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

  /** The deployment's history, oldest first. */
  async listEvents(id: string, ownerId: string): Promise<DeploymentEventView[]> {
    await this.get(id, ownerId);
    const events = await this.deps.prisma.deploymentEvent.findMany({
      where: { deploymentId: id },
      orderBy: { id: "asc" },
      include: { actor: { select: { login: true } } },
    });
    return events.map(({ actor, actorId: _actorId, deploymentId: _deploymentId, ...event }) => ({
      ...event,
      actor: actor?.login ?? null,
    }));
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

  /**
   * Streams a deployment's logs as they are produced: the build log until the
   * build ends, or the app's output (starting with its last `tail` lines)
   * until the container stops. Resolves when there is nothing more to send.
   */
  async followLogs(
    id: string,
    ownerId: string,
    type: LogType,
    tail: number,
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{ message?: string }> {
    const deployment = await this.get(id, ownerId);
    if (type === "build") {
      await this.deps.buildLogs.follow(id, onText, signal);
      return {};
    }
    if (!deployment.containerId) return { message: "This deployment never started a container." };
    try {
      await this.deps.engine.followLogs(deployment.containerId, tail, (chunk) => onText(chunk.text), signal);
      return {};
    } catch (error) {
      if (error instanceof NotFoundError) return { message: "The container no longer exists." };
      throw error;
    }
  }

  // ───────────────────────── commands ─────────────────────────

  /**
   * Creates a QUEUED deployment for the project's configured branch and starts
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
      deployment = await this.deps.prisma.$transaction(async (tx) => {
        const created = await tx.deployment.create({
          data: {
            id,
            projectId,
            trigger,
            branch: project.branch,
            ...DeploymentEngine.artifactNames({ id, name: project.slug }),
          },
        });
        await tx.deploymentEvent.create({
          data: {
            deploymentId: id,
            type: DeploymentEventType.CREATED,
            toStatus: DeploymentStatus.QUEUED,
            // A push is Shipyard acting on GitHub's behalf, not the owner clicking "Deploy".
            actorId: trigger === DeploymentTrigger.MANUAL ? ownerId : null,
            message: trigger === DeploymentTrigger.PUSH ? `Push to ${project.branch}` : null,
          },
        });
        return created;
      });
    } catch (error) {
      this.unlockProject(projectId);
      throw error;
    }

    await this.deps.audit.record({
      action: "DEPLOYMENT_STARTED",
      actorId: trigger === DeploymentTrigger.MANUAL ? ownerId : null,
      project,
      metadata: { deploymentId: deployment.id, trigger, branch: project.branch },
    });
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
    return this.stopDeployment(deployment, { actorId: ownerId });
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
      let current = await this.moveTo(deployment, DeploymentStatus.STARTING, {}, { actorId: ownerId, message: "Restart" });
      let result;
      try {
        const route = { name: project.slug, aliases: await this.projectDomains(project.id) };
        result = await this.deps.engine.restart(deployment.containerId, route, async (stage) => {
          current = await this.moveTo(current, stage);
        });
      } catch (error) {
        await this.markFailed(id, error, current.status);
        throw error;
      }
      const running = await this.moveTo(current, DeploymentStatus.RUNNING, {
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
   * Brings back the newest earlier deployment that ran successfully and still
   * has its container, through the same health check and traffic switch as a
   * deploy, then retires whatever was live. If the rollback fails, the current
   * deployment keeps serving. Idempotent: rolling back the same deployment
   * again returns the deployment it was rolled back to, while that is live.
   */
  async rollback(id: string, ownerId: string): Promise<Deployment> {
    const source = await this.get(id, ownerId);
    const project = await this.getProject(source.projectId, ownerId);
    const { prisma } = this.deps;

    const done = await prisma.deploymentEvent.findFirst({
      where: { deploymentId: id, type: DeploymentEventType.ROLLBACK, relatedDeploymentId: { not: null } },
      orderBy: { id: "desc" },
    });
    if (done?.relatedDeploymentId) {
      const restored = await prisma.deployment.findUnique({ where: { id: done.relatedDeploymentId } });
      if (restored?.status === DeploymentStatus.RUNNING) return restored;
    }
    if (IN_PROGRESS_STATUSES.includes(source.status)) {
      throw new ConflictError(ErrorCode.DEPLOYMENT_IN_PROGRESS, "This deployment is still in progress. Wait for it to finish.");
    }

    this.lockProject(project.id);
    try {
      const target = await this.findRollbackTarget(source);
      let current = await this.moveTo(target, DeploymentStatus.ROLLING_BACK, {}, {
        actorId: ownerId,
        message: `Rolling back from deployment ${displayId(source.id)}`,
      });
      let result;
      try {
        const route = { name: project.slug, aliases: await this.projectDomains(project.id) };
        result = await this.deps.engine.restart(target.containerId!, route, async (stage) => {
          current = await this.moveTo(current, stage);
        });
      } catch (error) {
        await this.markFailed(target.id, error, current.status);
        // Don't leave a half-started old version running next to the live one.
        await this.deps.engine.stop(target.containerId!).catch(() => {});
        throw error;
      }
      const running = await this.moveTo(current, DeploymentStatus.RUNNING, {
        hostPort: result.hostPort,
        deploymentUrl: result.deploymentUrl,
        errorMessage: null,
      });
      await this.retireOthers(project.id, target.id, `Rolled back to deployment ${displayId(target.id)}`);
      await prisma.deploymentEvent.createMany({
        data: [
          {
            deploymentId: source.id,
            type: DeploymentEventType.ROLLBACK,
            actorId: ownerId,
            relatedDeploymentId: target.id,
            message: `Rolled back to deployment ${displayId(target.id)}`,
          },
          {
            deploymentId: target.id,
            type: DeploymentEventType.ROLLBACK,
            actorId: ownerId,
            relatedDeploymentId: source.id,
            message: `Restored in place of deployment ${displayId(source.id)}`,
          },
        ],
      });
      this.deps.logger.info({ projectId: project.id, from: source.id, to: target.id }, "Rolled back");
      await this.deps.audit.record({
        action: "ROLLBACK",
        actorId: ownerId,
        project,
        metadata: { fromDeploymentId: source.id, toDeploymentId: target.id },
      });
      return running;
    } finally {
      this.unlockProject(project.id);
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

    const interrupted = await prisma.deployment.findMany({ where: { status: { in: [...IN_PROGRESS_STATUSES] } } });
    for (const deployment of interrupted) {
      if (deployment.containerId) await engine.stop(deployment.containerId).catch(() => {});
      await this.markFailed(
        deployment.id,
        `Interrupted: Shipyard stopped while this deployment was ${deployment.status}. Redeploy to try again.`,
        deployment.status,
      );
      summary.failed += 1;
    }

    const stopping = await prisma.deployment.findMany({ where: { status: DeploymentStatus.STOPPING } });
    for (const deployment of stopping) {
      if (deployment.containerId) await engine.stop(deployment.containerId).catch(() => {});
      await this.moveTo(
        deployment,
        DeploymentStatus.STOPPED,
        { hostPort: null, deploymentUrl: null },
        { message: "Finished stopping after Shipyard restarted" },
      );
      summary.stopped += 1;
    }

    const running = await prisma.deployment.findMany({
      where: { status: DeploymentStatus.RUNNING },
      include: { project: { select: { slug: true } } },
    });
    for (const deployment of running) {
      const reason = await this.checkStillRunning(deployment, deployment.project.slug);
      if (reason) {
        await this.markFailed(deployment.id, reason, DeploymentStatus.RUNNING);
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
        domains: await this.projectDomains(project.id),
        resources: {
          cpuLimit: project.cpuLimit,
          memoryLimitMb: project.memoryLimitMb,
          restartPolicy: project.restartPolicy,
        },
        healthCheck: {
          path: project.healthCheckPath,
          port: project.healthCheckPort,
          timeoutMs: project.healthCheckTimeoutSeconds === null ? null : project.healthCheckTimeoutSeconds * 1000,
        },
        env: (await this.deps.environment?.forDeployment(project.id)) ?? undefined,
      };

      await this.deps.engine.run(job, {
        onStatusChange: (state, previous) => this.persist(state, previous),
        onLog: (source, text) => logWriter.write(source === "runtime" ? prefixLines("[app] ", text) : text),
      });

      await this.retireOthers(project.id, deployment.id);
    } catch (error) {
      // The engine already persisted FAILED for errors inside the pipeline.
      if (!(error instanceof DeploymentFailedError)) {
        if (error instanceof AppError) {
          // Expected, before the pipeline started (e.g. a variable that can't be decrypted).
          logger.warn({ code: error.code, reason: error.message }, "Deployment could not start");
        } else {
          logger.error({ err: error }, "Deployment crashed outside the engine");
        }
        writer?.write(`ERROR: ${errorMessage(error)}\n`);
        await this.markFailed(deployment.id, error, DeploymentStatus.QUEUED);
      }
    } finally {
      await writer?.close().catch((closeError: unknown) => logger.warn({ err: closeError }, "Could not close build log"));
      const outcome = await this.deps.prisma.deployment.findUnique({ where: { id: deployment.id } });
      if (outcome) {
        const succeeded = outcome.status === DeploymentStatus.RUNNING;
        await this.deps.audit.record({
          action: succeeded ? "DEPLOYMENT_SUCCEEDED" : "DEPLOYMENT_FAILED",
          actorId: null,
          project,
          metadata: succeeded
            ? { deploymentId: outcome.id, commitSha: outcome.commitSha }
            : { deploymentId: outcome.id, failedStage: outcome.failedStage },
        });
      }
    }
  }

  private async persist(state: Readonly<DeploymentState>, previous: DeploymentStatus): Promise<void> {
    const { prisma } = this.deps;
    await prisma.$transaction([
      prisma.deployment.update({
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
          failedStage: state.failedStage,
          startedAt: state.startedAt,
          finishedAt: state.finishedAt,
        },
      }),
      prisma.deploymentEvent.create({
        data: {
          deploymentId: state.id,
          type: DeploymentEventType.STATUS_CHANGED,
          fromStatus: previous,
          toStatus: state.status,
          message: state.status === DeploymentStatus.FAILED ? state.errorMessage : null,
        },
      }),
    ]);
  }


  /**
   * Newest earlier deployment that reached RUNNING (deployments from before
   * event history count if they were stopped normally) and whose container
   * still exists. Containers removed outside Shipyard are skipped.
   */
  private async findRollbackTarget(source: Deployment): Promise<Deployment> {
    const candidates = await this.deps.prisma.deployment.findMany({
      where: {
        projectId: source.projectId,
        id: { not: source.id },
        createdAt: { lt: source.createdAt },
        status: DeploymentStatus.STOPPED,
        containerId: { not: null },
        OR: [{ events: { some: { toStatus: DeploymentStatus.RUNNING } } }, { events: { none: {} } }],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    for (const candidate of candidates) {
      try {
        await this.deps.engine.inspect(candidate.containerId!);
        return candidate;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    throw new ConflictError(
      ErrorCode.NO_ROLLBACK_TARGET,
      "There is no earlier deployment to roll back to: none that ran successfully still has its container.",
    );
  }

  /** Stops every other healthy deployment of the project, keeping containers for rollback. */
  private async retireOthers(projectId: string, keepId: string, reason?: string): Promise<void> {
    const others = await this.deps.prisma.deployment.findMany({
      where: {
        projectId,
        id: { not: keepId },
        status: { in: [DeploymentStatus.RUNNING, DeploymentStatus.HEALTHY] },
      },
    });
    for (const other of others) {
      await this.stopDeployment(other, { message: reason ?? `Replaced by deployment ${displayId(keepId)}` }).catch((error: unknown) =>
        this.deps.logger.warn({ err: error, deploymentId: other.id }, "Could not retire previous deployment"),
      );
    }
  }

  private async stopDeployment(deployment: Deployment, cause: Cause = {}): Promise<Deployment> {
    assertTransition(deployment.status, DeploymentStatus.STOPPING);
    const stopping = await this.moveTo(deployment, DeploymentStatus.STOPPING, {}, cause);
    try {
      // Out of the router first: visitors get a clean "not found", not errors from a stopping app.
      // A deployment being retired no longer has the route, so this is a no-op for it.
      await this.deactivateRoute(deployment);
      if (deployment.containerId) await this.deps.engine.stop(deployment.containerId);
    } catch (error) {
      // Removed outside Shipyard: it is certainly not running any more.
      if (!(error instanceof NotFoundError)) {
        await this.markFailed(deployment.id, error, DeploymentStatus.STOPPING);
        throw error;
      }
    }
    return this.moveTo(stopping, DeploymentStatus.STOPPED, { hostPort: null, deploymentUrl: null });
  }

  /**
   * Validated, race-safe status change: the UPDATE only matches if the row is
   * still in the status we read. If something else changed it in between, the
   * update matches 0 rows and we report a conflict instead of overwriting.
   * The change and its history event are written together, or not at all.
   */
  private async moveTo(
    deployment: Pick<Deployment, "id" | "status">,
    to: DeploymentStatus,
    data: Partial<Pick<Deployment, "hostPort" | "deploymentUrl" | "errorMessage">> = {},
    cause: Cause = {},
  ): Promise<Deployment> {
    assertTransition(deployment.status, to);
    await this.deps.prisma.$transaction(async (tx) => {
      const { count } = await tx.deployment.updateMany({
        where: { id: deployment.id, status: deployment.status },
        data: { status: to, ...data },
      });
      if (count === 0) {
        throw new ConflictError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          `Deployment ${deployment.id} changed while it was being updated. Refresh and try again.`,
        );
      }
      await recordStatusChange(tx, deployment.id, deployment.status, to, cause);
    });
    return this.load(deployment.id);
  }

  private async markFailed(id: string, reason: unknown, failedStage?: DeploymentStatus): Promise<void> {
    const message = typeof reason === "string" ? reason : errorMessage(reason);
    await this.deps.prisma
      .$transaction(async (tx) => {
        const current = await tx.deployment.findUnique({ where: { id }, select: { status: true } });
        if (!current || current.status === DeploymentStatus.FAILED) return;
        const { count } = await tx.deployment.updateMany({
          where: { id, status: current.status },
          data: {
            status: DeploymentStatus.FAILED,
            ...(failedStage && { failedStage }),
            errorMessage: message,
            finishedAt: new Date(),
          },
        });
        if (count === 1) await recordStatusChange(tx, id, current.status, DeploymentStatus.FAILED, { message });
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
      include: { project: { select: { slug: true, domains: { select: { hostname: true }, orderBy: { hostname: "asc" } } } } },
      orderBy: { finishedAt: "asc" },
    });
    const targets = new Map<string, RouteTarget>();
    for (const deployment of running) {
      if (!deployment.containerName || deployment.containerPort === null) continue;
      targets.set(deployment.project.slug, {
        name: deployment.project.slug,
        aliases: deployment.project.domains.map((domain) => domain.hostname),
        deploymentId: deployment.id,
        containerName: deployment.containerName,
        containerPort: deployment.containerPort,
      });
    }
    await this.deps.router.sync([...targets.values()]);
  }

  /**
   * Re-applies the project's route to its live deployment, e.g. after its
   * custom domains changed. No live deployment: nothing to do (the next
   * deploy picks the domains up).
   */
  async refreshRoute(projectId: string): Promise<void> {
    const live = await this.deps.prisma.deployment.findFirst({
      where: { projectId, status: DeploymentStatus.RUNNING },
      include: { project: { select: { slug: true } } },
      orderBy: { finishedAt: "desc" },
    });
    if (!live?.containerName || live.containerPort === null) return;
    await this.deps.router.activate({
      name: live.project.slug,
      aliases: await this.projectDomains(projectId),
      deploymentId: live.id,
      containerName: live.containerName,
      containerPort: live.containerPort,
    });
  }

  private async projectDomains(projectId: string): Promise<string[]> {
    const domains = await this.deps.prisma.projectDomain.findMany({
      where: { projectId },
      select: { hostname: true },
      orderBy: { hostname: "asc" },
    });
    return domains.map((domain) => domain.hostname);
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

function recordStatusChange(
  tx: Prisma.TransactionClient,
  deploymentId: string,
  fromStatus: DeploymentStatus,
  toStatus: DeploymentStatus,
  cause: Cause,
) {
  return tx.deploymentEvent.create({
    data: {
      deploymentId,
      type: DeploymentEventType.STATUS_CHANGED,
      fromStatus,
      toStatus,
      actorId: cause.actorId ?? null,
      message: cause.message ?? null,
    },
  });
}

/** The short id the dashboard shows. */
function displayId(deploymentId: string): string {
  return deploymentId.replace(/-/g, "").slice(0, 7);
}

function prefixLines(prefix: string, text: string): string {
  return text.replace(/^(?=.)/gm, prefix);
}

