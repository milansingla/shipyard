import { randomUUID } from "node:crypto";

import {
  type Deployment,
  DeploymentEventType,
  DeploymentTrigger,
  OrgRole,
  type Prisma,
  type PrismaClient,
  type Project,
} from "../../db/prisma.js";
import { AppError, ConflictError, ErrorCode, NotFoundError, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { DeploymentEngine, DeploymentFailedError, replicaRouting } from "../../services/deployment/DeploymentEngine.js";
import { DeploymentStatus, IN_PROGRESS_STATUSES, assertTransition } from "../../services/deployment/status.js";
import type { DeploymentJob, DeploymentState } from "../../services/deployment/types.js";
import { ShipyardLabel } from "../../services/docker/DockerService.js";
import { formatLogChunks } from "../../services/docker/logs.js";
import { parseRepositoryUrl } from "../../services/git/repositoryUrl.js";
import type { RouteTarget, Router } from "../../services/routing/Router.js";
import type { DeployJob, Environment, Service } from "../../db/prisma.js";
import { JOB_SLOTS_PER_WORKER, eligibleWorkers, pickWorker } from "./scheduler.js";
import type { PolicyService } from "../policies/PolicyService.js";

/** A running job's claim; its worker renews it every 20 s. */
const LEASE_SECONDS = 60;
/** A job lost with its worker is retried at most this many times in all. */
const MAX_JOB_ATTEMPTS = 3;
import { environmentRouteName, variableEnvironment } from "../environments/environmentRules.js";
import type { AccessService, ProjectWithRole } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";
import type { EnvironmentService } from "../environment/EnvironmentService.js";
import type { ConfigSync } from "../services/ConfigSync.js";
import {
  artifactName,
  effectiveHealthCheck,
  effectiveResources,
  primaryServiceId,
  projectNetworkName,
  routeName,
  serviceSpec,
} from "../services/serviceRules.js";
import type { BuildLogStore, BuildLogWriter } from "./BuildLogStore.js";

export type EngineLike = Pick<
  DeploymentEngine,
  | "run"
  | "stop"
  | "restart"
  | "getLogs"
  | "followLogs"
  | "destroy"
  | "inspect"
  | "ensureRoutable"
  | "artifactNames"
  | "removeNetwork"
  | "removeVolumes"
  | "stats"
>;

export interface DeploymentServiceDeps {
  prisma: PrismaClient;
  /** This machine's engine (the built-in worker). */
  engine: EngineLike;
  /** The organization's rules: checked before queueing; may hold production deploys for approval. */
  policies?: Pick<PolicyService, "assertCanDeploy" | "needsApproval">;
  /** Told when a deployment finished (alerting). */
  onFinished?: (input: { deployment: Deployment; project: Project; serviceName: string }) => Promise<void>;
  /** The engine of a remote worker, by id; omitted = every deployment runs here. */
  remoteEngine?: (workerId: string) => EngineLike;
  access: AccessService;
  /** Decrypts the project's variables for each deployment; null = no variables (no secret key). */
  environment: Pick<EnvironmentService, "forDeployment"> | null;
  /** Syncs services from the repository's shipyard.yaml before each deploy; null = no file support. */
  configSync?: Pick<ConfigSync, "sync"> | null;
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
 * Deploys go through a durable queue (`deploy_jobs`): deploy() records the
 * deployments and a job in one transaction and returns; a worker claims the
 * job (FOR UPDATE SKIP LOCKED) and runs it under a lease it keeps renewing.
 * The database allows one RUNNING job per project environment, so two
 * workers (or processes) never deploy the same environment at once. Pushes
 * that arrive while a push deploy is still queued are coalesced into it: it
 * builds the branch's latest commit anyway.
 *
 * Authorization: every public method takes the acting user's id and only
 * finds deployments of that user's projects; anything else is a 404.
 */
export class DeploymentService {
  /** Lock keys (project, or project/environment) held by a restart, rollback, close or delete in this process. */
  private readonly busyProjects = new Set<string>();
  /** Projects held whole (deleting it or one of its services): no environment of theirs may start a job. */
  private readonly busyWholeProjects = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Jobs this process is orchestrating, by job id, with the worker running them (null = this machine, unregistered). */
  private readonly activeJobs = new Map<string, { workerId: string | null; run: Promise<void> }>();
  /** This process's worker (the built-in one); null = not registered (tests, the CLI). */
  private localWorkerId: string | null = null;
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  /** Jobs claimed so far (lets waitForIdle tell progress from a stall). */
  private claimed = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DeploymentServiceDeps) {}

  /** Makes this process run queued jobs as `workerId` (the built-in worker). */
  attachWorker(workerId: string | null): void {
    this.localWorkerId = workerId;
  }

  /** Polls the queue and renews leases; deploy() also wakes it immediately. */
  startQueue(intervalMs = 2_000): void {
    if (this.timer) return;
    let ticks = 0;
    this.timer = setInterval(() => {
      ticks += 1;
      this.kick();
      if (ticks % 10 === 0) {
        void this.renewLeases()
          .then(() => this.recoverLostJobs())
          .catch((error: unknown) => this.deps.logger.error({ err: error }, "Queue maintenance failed"));
      }
    }, intervalMs);
    this.timer.unref();
  }

  stopQueue(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ───────────────────────── queries ─────────────────────────

  async get(id: string, userId: string): Promise<Deployment> {
    return (await this.deps.access.deployment(id, userId)).deployment;
  }

  async listForProject(projectId: string, userId: string, limit: number): Promise<Deployment[]> {
    await this.deps.access.project(projectId, userId);
    return this.deps.prisma.deployment.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  /** The deployment's history, oldest first. */
  async listEvents(id: string, userId: string): Promise<DeploymentEventView[]> {
    await this.get(id, userId);
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

  async getLogs(id: string, userId: string, type: LogType, tail: number): Promise<DeploymentLogs> {
    const deployment = await this.get(id, userId);

    if (type === "build") {
      return { type, content: await this.deps.buildLogs.read(id) };
    }
    if (!deployment.containerId) {
      return { type, content: "", message: "This deployment never started a container." };
    }
    try {
      return { type, content: formatLogChunks(await this.engineFor(deployment.workerId).getLogs(deployment.containerId, tail)) };
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
    userId: string,
    type: LogType,
    tail: number,
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{ message?: string }> {
    const deployment = await this.get(id, userId);
    if (type === "build") {
      await this.deps.buildLogs.follow(id, onText, signal);
      return {};
    }
    if (!deployment.containerId) return { message: "This deployment never started a container." };
    try {
      await this.engineFor(deployment.workerId).followLogs(deployment.containerId, tail, (chunk) => onText(chunk.text), signal);
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
  /**
   * `actorId` null = Shipyard itself (a verified push): no person's role is
   * checked. Otherwise the person needs DEVELOPER in the project's organization.
   */
  /**
   * Deploys every service of the project (or only `serviceIds`) at the
   * latest commit of its branch: one deployment per service, run in the
   * background. Returns the primary web service's deployment (else the first).
   *
   * `actorId` null = Shipyard itself (a verified push): no person's role is
   * checked. Otherwise the person needs DEVELOPER in the project's organization.
   */
  async deploy(
    projectId: string,
    actorId: string | null,
    trigger: DeploymentTrigger = DeploymentTrigger.MANUAL,
    options: { serviceIds?: readonly string[]; environmentId?: string; retryOf?: string; preApproved?: boolean } = {},
  ): Promise<Deployment> {
    const project =
      actorId === null
        ? await this.loadProject(projectId)
        : await this.deps.access.project(projectId, actorId, OrgRole.DEVELOPER);
    const environment = options.environmentId ? await this.activeEnvironment(projectId, options.environmentId) : null;
    // shipyard.yaml first: it may add services or change how they build. A broken file
    // still produces a deployment (FAILED, with the reason) so a push doesn't fail silently.
    // Only for production: another environment's branch (a pull request) must not
    // change the project's services.
    let notes: string[] = [];
    if (!environment) {
      try {
        notes = (await this.deps.configSync?.sync(project)) ?? [];
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== ErrorCode.CONFIG_INVALID) throw error;
        return this.recordConfigFailure(project, actorId, trigger, error);
      }
    }
    const services = await this.services(projectId);
    // Other environments run the web services and workers; databases (and their data) are production's.
    const candidates = environment ? services.filter((service) => service.type !== "POSTGRES") : services;
    const selected = options.serviceIds
      ? candidates.filter((service) => options.serviceIds!.includes(service.id))
      : environment
        ? candidates
        : await this.withoutRunningDatabases(candidates);
    if (selected.length === 0) {
      if (options.serviceIds) throw new NotFoundError("No such service in this project.");
      throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "Nothing to deploy: the database is already running. Deploy it from its service to restart it.");
    }
    const lock = lockKey(projectId, environment?.id ?? null);
    await this.deps.policies?.assertCanDeploy(project, selected, environment);
    const actorRole = actorId === null ? null : (project as ProjectWithRole).role;
    const awaitingApproval = !options.preApproved && Boolean(await this.deps.policies?.needsApproval(project, actorRole, environment));

    const deployments: Deployment[] = await this.deps.prisma.$transaction(async (tx) => {
        const created: Deployment[] = [];
        for (const service of selected) {
          const id = randomUUID();
          created.push(
            await tx.deployment.create({
              data: {
                id,
                projectId,
                serviceId: service.id,
                environmentId: environment?.id ?? null,
                trigger,
                branch: environment?.branch ?? project.branch,
                ...this.deps.engine.artifactNames({ id, name: deploymentArtifactName(project, service, environment) }),
              },
            }),
          );
          await tx.deploymentEvent.create({
            data: {
              deploymentId: id,
              type: DeploymentEventType.CREATED,
              toStatus: DeploymentStatus.QUEUED,
              // A push is Shipyard acting on GitHub's behalf, not the owner clicking "Deploy".
              actorId,
              message: trigger === DeploymentTrigger.PUSH ? `Push to ${environment?.branch ?? project.branch}` : null,
            },
          });
        }
        await tx.deployJob.create({
          data: {
            projectId,
            environmentId: environment?.id ?? null,
            lockKey: lock,
            deploymentIds: created.map((deployment) => deployment.id),
            notes,
            trigger,
            // A person waiting beats a push.
            priority: trigger === DeploymentTrigger.MANUAL ? 10 : 0,
            retryOfId: options.retryOf ?? null,
            status: awaitingApproval ? "AWAITING_APPROVAL" : "QUEUED",
          },
        });
        return created;
      });

    for (const deployment of deployments) {
      await this.deps.audit.record({
        action: "DEPLOYMENT_STARTED",
        actorId,
        project,
        metadata: {
          deploymentId: deployment.id,
          service: services.find((service) => service.id === deployment.serviceId)!.name,
          trigger,
          branch: environment?.branch ?? project.branch,
          ...(environment && { environment: environment.name }),
        },
      });
    }
    this.kick();
    const primaryId = primaryServiceId(services);
    return deployments.find((deployment) => deployment.serviceId === primaryId) ?? deployments[0]!;
  }


  /**
   * Deploys after a GitHub push, as Shipyard (the push's signature was
   * verified). Unlike deploy(), a busy project is not an error: the push is
   * remembered and deployed when the current work ends.
   */
  async deployOnPush(projectId: string, environmentId: string | null = null): Promise<PushDeployResult> {
    const key = lockKey(projectId, environmentId);
    const { prisma } = this.deps;
    // A push deploy still waiting will build the branch's latest commit: this push rides along.
    if (
      await prisma.deployJob.findFirst({
        where: { lockKey: key, status: { in: ["QUEUED", "AWAITING_APPROVAL"] }, trigger: DeploymentTrigger.PUSH },
        select: { id: true },
      })
    ) {
      return { outcome: "queued" };
    }
    const busy =
      this.busyProjects.has(key) ||
      (await prisma.deployJob.count({ where: { lockKey: key, status: { in: ["QUEUED", "RUNNING"] } } })) > 0;
    const deployment = await this.deploy(projectId, null, DeploymentTrigger.PUSH, environmentId ? { environmentId } : {});
    return busy ? { outcome: "queued" } : { outcome: "started", deployment };
  }

  /** Cancels a deployment whose job hasn't started yet: every deployment of that job is marked FAILED. */
  async cancel(id: string, userId: string): Promise<Deployment> {
    const { deployment } = await this.deps.access.deployment(id, userId, OrgRole.DEVELOPER);
    const job = await this.deps.prisma.deployJob.findFirst({ where: { deploymentIds: { has: id } } });
    if (!job || (job.status !== "QUEUED" && job.status !== "AWAITING_APPROVAL")) {
      throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "Only a deployment still waiting in the queue can be cancelled.");
    }
    const { count } = await this.deps.prisma.deployJob.updateMany({
      where: { id: job.id, status: { in: ["QUEUED", "AWAITING_APPROVAL"] } },
      data: { status: "CANCELLED", finishedAt: new Date(), error: "Cancelled" },
    });
    if (count !== 1) throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "It has just started; it can't be cancelled any more.");
    for (const deploymentId of job.deploymentIds) {
      await this.markFailed(deploymentId, "Cancelled before it started.", DeploymentStatus.QUEUED);
    }
    return this.load(deployment.id);
  }

  /** Deploys the latest commit of the same project/branch as an existing deployment. */
  async redeploy(id: string, userId: string): Promise<Deployment> {
    const deployment = await this.get(id, userId);
    return this.deploy(deployment.projectId, userId);
  }

  async stop(id: string, userId: string): Promise<Deployment> {
    const { deployment } = await this.deps.access.deployment(id, userId, OrgRole.DEVELOPER);
    if (deployment.status === DeploymentStatus.STOPPED) return deployment;
    return this.stopDeployment(deployment, { actorId: userId });
  }

  /**
   * Restarts a RUNNING or STOPPED deployment and waits for its health check.
   * Restarting an older, stopped deployment also retires the currently running
   * one — which makes this the rollback mechanism.
   */
  async restart(id: string, userId: string): Promise<Deployment> {
    const { deployment, project } = await this.deps.access.deployment(id, userId, OrgRole.DEVELOPER);
    if (deployment.environmentId) await this.activeEnvironment(project.id, deployment.environmentId);
    assertTransition(deployment.status, DeploymentStatus.STARTING);
    if (!deployment.containerId) {
      throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "This deployment has no container to restart.");
    }

    const lock = lockKey(deployment.projectId, deployment.environmentId);
    await this.lockProject(lock);
    try {
      const stopped = await this.stopForReplacement(deployment, `Stopped to restart deployment ${displayId(id)}`);
      let current = await this.moveTo(deployment, DeploymentStatus.STARTING, {}, { actorId: userId, message: "Restart" });
      let result;
      try {
        const route = await this.routeFor(project, deployment);
        result = await this.engineFor(deployment.workerId).restart(deployment.containerId, route, async (stage) => {
          current = await this.moveTo(current, stage);
        });
      } catch (error) {
        await this.markFailed(id, error, current.status);
        await this.revive(stopped);
        throw error;
      }
      const running = await this.moveTo(current, DeploymentStatus.RUNNING, {
        hostPort: result.hostPort,
        deploymentUrl: result.deploymentUrl,
        errorMessage: null,
      });
      await this.retireOthers(deployment, id);
      return running;
    } finally {
      this.unlockProject(lock);
    }
  }

  /**
   * Brings back the newest earlier deployment that ran successfully and still
   * has its container, through the same health check and traffic switch as a
   * deploy, then retires whatever was live. If the rollback fails, the current
   * deployment keeps serving. Idempotent: rolling back the same deployment
   * again returns the deployment it was rolled back to, while that is live.
   */
  async rollback(id: string, userId: string): Promise<Deployment> {
    const { deployment: source, project } = await this.deps.access.deployment(id, userId, OrgRole.DEVELOPER);
    if (source.environmentId) await this.activeEnvironment(project.id, source.environmentId);
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

    const lock = lockKey(project.id, source.environmentId);
    await this.lockProject(lock);
    try {
      const target = await this.findRollbackTarget(source);
      const stopped = await this.stopForReplacement(target, `Stopped to roll back to deployment ${displayId(target.id)}`);
      let current = await this.moveTo(target, DeploymentStatus.ROLLING_BACK, {}, {
        actorId: userId,
        message: `Rolling back from deployment ${displayId(source.id)}`,
      });
      let result;
      try {
        const route = await this.routeFor(project, target);
        result = await this.engineFor(target.workerId).restart(target.containerId!, route, async (stage) => {
          current = await this.moveTo(current, stage);
        });
      } catch (error) {
        await this.markFailed(target.id, error, current.status);
        // Don't leave a half-started old version running next to the live one.
        await this.engineFor(target.workerId).stop(target.containerId!).catch(() => {});
        await this.revive(stopped);
        throw error;
      }
      const running = await this.moveTo(current, DeploymentStatus.RUNNING, {
        hostPort: result.hostPort,
        deploymentUrl: result.deploymentUrl,
        errorMessage: null,
      });
      await this.retireOthers(target, target.id, `Rolled back to deployment ${displayId(target.id)}`);
      await prisma.deploymentEvent.createMany({
        data: [
          {
            deploymentId: source.id,
            type: DeploymentEventType.ROLLBACK,
            actorId: userId,
            relatedDeploymentId: target.id,
            message: `Rolled back to deployment ${displayId(target.id)}`,
          },
          {
            deploymentId: target.id,
            type: DeploymentEventType.ROLLBACK,
            actorId: userId,
            relatedDeploymentId: source.id,
            message: `Restored in place of deployment ${displayId(source.id)}`,
          },
        ],
      });
      this.deps.logger.info({ projectId: project.id, from: source.id, to: target.id }, "Rolled back");
      await this.deps.audit.record({
        action: "ROLLBACK",
        actorId: userId,
        project,
        metadata: { fromDeploymentId: source.id, toDeploymentId: target.id },
      });
      return running;
    } finally {
      this.unlockProject(lock);
    }
  }

  /**
   * A deploy that couldn't start because shipyard.yaml is invalid: recorded as a
   * FAILED deployment of the primary service, with the reason, in its history.
   */
  private async recordConfigFailure(
    project: Project,
    actorId: string | null,
    trigger: DeploymentTrigger,
    error: AppError,
  ): Promise<Deployment> {
    const services = await this.services(project.id);
    const service = services.find((candidate) => candidate.id === primaryServiceId(services)) ?? services[0]!;
    const id = randomUUID();
    const deployment = await this.deps.prisma.$transaction(async (tx) => {
      const created = await tx.deployment.create({
        data: {
          id,
          projectId: project.id,
          serviceId: service.id,
          trigger,
          branch: project.branch,
          status: DeploymentStatus.FAILED,
          failedStage: DeploymentStatus.QUEUED,
          errorMessage: error.message,
          finishedAt: new Date(),
          ...this.deps.engine.artifactNames({ id, name: artifactName(project, service) }),
        },
      });
      await tx.deploymentEvent.create({
        data: { deploymentId: id, type: DeploymentEventType.CREATED, toStatus: DeploymentStatus.QUEUED, actorId },
      });
      await tx.deploymentEvent.create({
        data: {
          deploymentId: id,
          type: DeploymentEventType.STATUS_CHANGED,
          fromStatus: DeploymentStatus.QUEUED,
          toStatus: DeploymentStatus.FAILED,
          message: error.message,
        },
      });
      return created;
    });
    const writer = await this.deps.buildLogs.open(id);
    writer.write(`ERROR: ${error.message}\n`);
    await writer.close();
    await this.deps.audit.record({
      action: "DEPLOYMENT_FAILED",
      actorId: null,
      project,
      metadata: { deploymentId: id, service: service.name, failedStage: DeploymentStatus.QUEUED },
    });
    return deployment;
  }

  /**
   * Deletes Docker volumes and their data, on every worker that ran the
   * project (a volume lives where its containers ran). Only after the containers are gone.
   */
  async removeVolumes(dockerNames: readonly string[], projectId?: string): Promise<void> {
    if (dockerNames.length === 0) return;
    for (const workerId of projectId ? await this.workersOf(projectId) : [null]) {
      await this.engineFor(workerId).removeVolumes(dockerNames);
    }
  }

  /** Workers that hosted any deployment of the project (null = this machine). */
  private async workersOf(projectId: string): Promise<Array<string | null>> {
    const rows = await this.deps.prisma.deployment.findMany({ where: { projectId }, distinct: ["workerId"], select: { workerId: true } });
    const ids = new Set<string | null>(rows.map((row) => (row.workerId === this.localWorkerId ? null : row.workerId)));
    ids.add(null);
    return [...ids];
  }

  /** Containers on another worker are reached at its address and their published ports. */
  private async remoteServers(deployment: Pick<Deployment, "workerId" | "hostPorts">): Promise<{ servers?: string[] }> {
    if (!deployment.workerId || deployment.workerId === this.localWorkerId) return {};
    const worker = await this.deps.prisma.worker.findUnique({ where: { id: deployment.workerId }, select: { address: true } });
    if (!worker?.address) return {};
    return { servers: deployment.hostPorts.map((port) => `http://${worker.address}:${port}`) };
  }

  /**
   * Removes a finished deployment's containers and image, keeping its record
   * (history). For cleanup; refused (false) while its environment is busy or
   * if it is live, in progress, or not finished.
   */
  async pruneArtifacts(deployment: Deployment): Promise<boolean> {
    if (deployment.status !== DeploymentStatus.FAILED && deployment.status !== DeploymentStatus.STOPPED) return false;
    const key = lockKey(deployment.projectId, deployment.environmentId);
    try {
      await this.lockProject(key);
    } catch {
      return false;
    }
    try {
      await this.engineFor(deployment.workerId).destroy({ deploymentId: deployment.id, containerId: deployment.containerId, imageName: deployment.imageName });
      await this.deps.prisma.deployment.update({ where: { id: deployment.id }, data: { containerId: null, hostPort: null, hostPorts: [] } });
      return true;
    } finally {
      this.unlockProject(key);
    }
  }

  /** Resource use of a deployment's replicas, from the worker running it. */
  async statsFor(deployment: Pick<Deployment, "workerId" | "containerId">) {
    if (!deployment.containerId) return [];
    return this.engineFor(deployment.workerId).stats(deployment.containerId);
  }

  /** This machine's worker (or unregistered: then everything is local). */
  isLocalWorker(workerId: string | null): boolean {
    return !workerId || workerId === this.localWorkerId;
  }

  /** The engine of the worker hosting a deployment: this machine's, or a remote worker's. */
  private engineFor(workerId: string | null): EngineLike {
    if (!workerId || workerId === this.localWorkerId || !this.deps.remoteEngine) return this.deps.engine;
    return this.deps.remoteEngine(workerId);
  }

  /** Like destroyProjectDeployments, for one service (see ServiceService.delete). */
  async destroyServiceDeployments(projectId: string, serviceId: string, finalize: () => Promise<void>): Promise<void> {
    await this.lockWholeProject(projectId);
    try {
      const deployments = await this.deps.prisma.deployment.findMany({ where: { serviceId } });
      for (const deployment of deployments) {
        await this.deactivateRoute(deployment);
        await this.engineFor(deployment.workerId).destroy({ deploymentId: deployment.id, containerId: deployment.containerId, imageName: deployment.imageName });
        await this.deps.buildLogs.remove(deployment.id);
      }
      await finalize();
    } finally {
      this.unlockProject(projectId);
    }
  }

  /**
   * Removes every container, image and log of a project, then runs `finalize`
   * (deleting the project row) while still holding the project lock, so no new
   * deployment can sneak in between.
   */
  /**
   * Takes an environment down: its live deployments are stopped and every
   * container and image of it removed. The deployments stay as history.
   */
  async closeEnvironment(projectId: string, environmentId: string, finalize: () => Promise<void>): Promise<void> {
    const lock = lockKey(projectId, environmentId);
    await this.lockProject(lock);
    try {
      const deployments = await this.deps.prisma.deployment.findMany({ where: { environmentId } });
      for (const deployment of deployments) {
        if (deployment.status === DeploymentStatus.RUNNING || deployment.status === DeploymentStatus.HEALTHY) {
          await this.stopDeployment(deployment, { message: "Environment closed" });
        }
        await this.engineFor(deployment.workerId).destroy({ deploymentId: deployment.id, containerId: deployment.containerId, imageName: deployment.imageName });
      }
      await finalize();
    } finally {
      this.unlockProject(lock);
    }
  }

  async destroyProjectDeployments(projectId: string, finalize: () => Promise<void>): Promise<void> {
    await this.lockWholeProject(projectId);
    try {
      const deployments = await this.deps.prisma.deployment.findMany({ where: { projectId } });
      for (const deployment of deployments) {
        await this.deactivateRoute(deployment);
        // If Docker is unreachable this throws and the project is NOT deleted,
        // so no containers are orphaned. The user can simply retry.
        await this.engineFor(deployment.workerId).destroy({ deploymentId: deployment.id, containerId: deployment.containerId, imageName: deployment.imageName });
        await this.deps.buildLogs.remove(deployment.id);
      }
      for (const workerId of await this.workersOf(projectId)) {
        await this.engineFor(workerId).removeNetwork(projectNetworkName(projectId));
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

    // Jobs this worker was running died with the previous process. Jobs still
    // queued survive and run; jobs on other workers are theirs (see recoverLostJobs).
    const died = await prisma.deployJob.findMany({
      where: { status: "RUNNING", OR: [{ workerId: null }, ...(this.localWorkerId ? [{ workerId: this.localWorkerId }] : [])] },
    });
    await prisma.deployJob.updateMany({
      where: { id: { in: died.map((job) => job.id) } },
      data: { status: "FAILED", error: "Interrupted: Shipyard restarted", finishedAt: new Date(), leaseExpiresAt: null },
    });
    const elsewhere = await prisma.deployJob.findMany({
      where: { OR: [{ status: "QUEUED" }, { status: "RUNNING", workerId: { not: this.localWorkerId } }] },
      select: { deploymentIds: true },
    });
    const keep = new Set(elsewhere.flatMap((job) => job.deploymentIds));
    const interrupted = (await prisma.deployment.findMany({ where: { status: { in: [...IN_PROGRESS_STATUSES] } } })).filter(
      (deployment) => !keep.has(deployment.id),
    );
    for (const deployment of interrupted) {
      if (deployment.containerId) await this.engineFor(deployment.workerId).stop(deployment.containerId).catch(() => {});
      await this.markFailed(
        deployment.id,
        `Interrupted: Shipyard stopped while this deployment was ${deployment.status}. Redeploy to try again.`,
        deployment.status,
      );
      summary.failed += 1;
    }

    const stopping = await prisma.deployment.findMany({ where: { status: DeploymentStatus.STOPPING } });
    for (const deployment of stopping) {
      if (deployment.containerId) await this.engineFor(deployment.workerId).stop(deployment.containerId).catch(() => {});
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
      include: { project: { select: { id: true, slug: true } } },
    });
    for (const deployment of running) {
      const route = await this.routeFor(deployment.project, deployment);
      const reason = await this.checkStillRunning(deployment, route?.name ?? null);
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
  /** Resolves once nothing is running here and nothing this process could run is queued. */
  async waitForIdle(): Promise<void> {
    for (;;) {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
      const queued = await this.deps.prisma.deployJob.count({
        where: { status: "QUEUED", OR: [{ workerId: null }, ...(this.localWorkerId ? [{ workerId: this.localWorkerId }] : [])] },
      });
      if (queued === 0 || this.busyProjects.size > 0 || this.busyWholeProjects.size > 0) return;
      const claimedBefore = this.claimed;
      this.kick();
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
      // Nothing claimable (another worker holds that environment): don't spin.
      if (this.claimed === claimedBefore) return;
    }
  }

  // ───────────────────────── internals ─────────────────────────

  /**
   * Runs a project's deployments one after another: private services and
   * workers first, the primary web service last, so a new frontend never goes
   * live before the backend it calls. Each service switches with zero downtime
   * on its own; one failing doesn't stop the others (it keeps its previous version).
   */
  private async executeAll(
    project: Project,
    deployments: Deployment[],
    services: Service[],
    notes: string[] = [],
    environment: Environment | null = null,
  ): Promise<void> {
    const primaryId = primaryServiceId(services);
    const order = (deployment: Deployment) => {
      const service = services.find((s) => s.id === deployment.serviceId)!;
      // Databases first: the apps that connect to them start after.
      if (service.type === "POSTGRES") return -1;
      return service.id === primaryId ? 2 : service.type === "WEB" && service.public ? 1 : 0;
    };
    for (const deployment of [...deployments].sort((a, b) => order(a) - order(b))) {
      await this.execute(project, deployment, services.find((s) => s.id === deployment.serviceId)!, primaryId, notes, environment);
    }
  }

  private async execute(
    project: Project,
    deployment: Deployment,
    service: Service,
    primaryId: string | null,
    notes: string[] = [],
    environment: Environment | null = null,
  ): Promise<void> {
    const logger = this.deps.logger.child({ deploymentId: deployment.id, projectId: project.id, service: service.name });
    let writer: BuildLogWriter | null = null;
    let stopped: Deployment[] = [];

    try {
      writer = await this.deps.buildLogs.open(deployment.id);
      const logWriter = writer;
      for (const note of notes) logWriter.write(`shipyard.yaml: ${note}\n`);
      const job: DeploymentJob = {
        id: deployment.id,
        // Re-validated on every deploy: the allowlist may have changed since creation.
        repository: parseRepositoryUrl(project.repositoryUrl, this.deps.allowedGitHosts),
        branch: deployment.branch,
        name: deploymentArtifactName(project, service, environment),
        routeName: environmentRouteName(environment, routeName(project, service, primaryId)),
        service: serviceSpec(project, service),
        labels: { [ShipyardLabel.PROJECT_ID]: project.id },
        // Custom domains, volumes (production data) and replicas are production's.
        domains: environment ? [] : await this.serviceDomains(project.id, service.id, primaryId),
        resources: effectiveResources(project, service),
        healthCheck: effectiveHealthCheck(project, service),
        replicas: environment || service.type === "POSTGRES" ? 1 : service.replicas,
        volumes: environment
          ? []
          : (await this.deps.prisma.volume.findMany({ where: { serviceId: service.id } })).map((volume) => ({
              name: volume.dockerName,
              mountPath: volume.mountPath,
            })),
        env: (await this.deps.environment?.forDeployment(project.id, service.id, variableEnvironment(environment))) ?? undefined,
      };

      if (job.service?.stopFirst) {
        stopped = await this.stopForReplacement(deployment, `Stopped for deployment ${displayId(deployment.id)}`);
        if (stopped.length > 0) logWriter.write(`Stopped the running ${service.name} first: two copies must never share its data\n`);
      }
      await this.engineFor(deployment.workerId).run(job, {
        onStatusChange: (state, previous) => this.persist(state, previous),
        onLog: (source, text) => logWriter.write(source === "runtime" ? prefixLines("[app] ", text) : text),
      });

      await this.retireOthers(deployment, deployment.id);
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
      if (stopped.length > 0) {
        writer?.write(`Restarting the previous ${service.name}\n`);
        await this.revive(stopped);
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
            ? { deploymentId: outcome.id, service: service.name, commitSha: outcome.commitSha }
            : { deploymentId: outcome.id, service: service.name, failedStage: outcome.failedStage },
        });
        await this.deps.onFinished?.({ deployment: outcome, project, serviceName: service.name }).catch((error: unknown) =>
          logger.warn({ err: error }, "Deployment outcome hook failed"),
        );
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
          hostPorts: state.hostPorts,
          replicas: state.replicas,
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
        serviceId: source.serviceId,
        environmentId: source.environmentId,
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
        await this.engineFor(candidate.workerId).inspect(candidate.containerId!);
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

  /**
   * For services that keep state no second copy may share (a database's data
   * directory): stops the running deployment BEFORE another one starts, and
   * returns what it stopped, to bring back if the new one fails. Throws if it
   * can't stop one: better no new deployment than two servers on one volume.
   */
  private async stopForReplacement(keep: Pick<Deployment, "id" | "serviceId" | "environmentId">, message: string): Promise<Deployment[]> {
    const service = await this.deps.prisma.service.findUnique({ where: { id: keep.serviceId }, select: { type: true } });
    if (service?.type !== "POSTGRES") return [];
    const running = await this.deps.prisma.deployment.findMany({
      where: {
        serviceId: keep.serviceId,
        environmentId: keep.environmentId,
        id: { not: keep.id },
        status: { in: [DeploymentStatus.RUNNING, DeploymentStatus.HEALTHY] },
      },
    });
    const stopped: Deployment[] = [];
    for (const deployment of running) stopped.push(await this.stopDeployment(deployment, { message }));
    return stopped;
  }

  /** Brings back deployments stopped for a replacement that failed. Best effort: failures are recorded on them. */
  private async revive(stopped: readonly Deployment[]): Promise<void> {
    for (const previous of stopped) {
      let current = await this.load(previous.id);
      try {
        current = await this.moveTo(current, DeploymentStatus.STARTING, {}, { message: "Restarted: its replacement failed" });
        const result = await this.engineFor(previous.workerId).restart(previous.containerId!, null, async (stage) => {
          current = await this.moveTo(current, stage);
        });
        await this.moveTo(current, DeploymentStatus.RUNNING, { hostPort: result.hostPort, deploymentUrl: null, errorMessage: null });
      } catch (error) {
        this.deps.logger.error({ err: error, deploymentId: previous.id }, "Could not bring back the previous deployment");
        await this.markFailed(previous.id, error, current.status).catch(() => {});
      }
    }
  }

  /** A project deploy (button, push, CLI) leaves running databases alone: restarting one is never a side effect. */
  private async withoutRunningDatabases(services: Service[]): Promise<Service[]> {
    const running = await this.deps.prisma.deployment.findMany({
      where: {
        serviceId: { in: services.filter((service) => service.type === "POSTGRES").map((service) => service.id) },
        environmentId: null,
        status: { in: [DeploymentStatus.RUNNING, ...IN_PROGRESS_STATUSES] },
      },
      select: { serviceId: true },
    });
    const busy = new Set(running.map((deployment) => deployment.serviceId));
    return services.filter((service) => !busy.has(service.id));
  }

  /** Stops the service's other healthy deployments in the same environment, keeping containers for rollback. */
  private async retireOthers(
    of: Pick<Deployment, "serviceId" | "environmentId">,
    keepId: string,
    reason?: string,
  ): Promise<void> {
    const others = await this.deps.prisma.deployment.findMany({
      where: {
        serviceId: of.serviceId,
        environmentId: of.environmentId,
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
      if (deployment.containerId) await this.engineFor(deployment.workerId).stop(deployment.containerId);
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
  /** `routeName` null = not routed (worker, private service): no URL, nothing to attach. */
  private async checkStillRunning(deployment: Deployment, routeName: string | null): Promise<string | null> {
    if (!deployment.containerId) return "Deployment has no container.";
    try {
      const container = await this.engineFor(deployment.workerId).inspect(deployment.containerId);
      if (!container.running) {
        return `Container exited${container.exitCode === null ? "" : ` with code ${container.exitCode}`} while Shipyard was not running.`;
      }
      // Not fatal: the app still runs; the router just can't reach it until this is fixed.
      if (routeName) {
        await this.engineFor(deployment.workerId)
          .ensureRoutable(deployment.containerId)
          .catch((error: unknown) =>
            this.deps.logger.warn({ err: error, deploymentId: deployment.id }, "Router cannot reach this deployment"),
          );
      }
      const deploymentUrl =
        routeName === null || container.hostPort === null ? null : this.deps.router.urlFor(routeName, container.hostPort);
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
      where: { status: DeploymentStatus.RUNNING, service: { type: "WEB", public: true } },
      include: { project: true, service: true },
      orderBy: { finishedAt: "asc" },
    });
    const targets = new Map<string, RouteTarget>();
    for (const deployment of running) {
      if (!deployment.containerName || deployment.containerPort === null) continue;
      const route = await this.routeFor(deployment.project, deployment);
      if (!route) continue;
      targets.set(route.name, {
        ...route,
        deploymentId: deployment.id,
        containerName: deployment.containerName,
        containerPort: deployment.containerPort,
        ...replicaRouting(deployment.containerName, deployment.replicas, effectiveHealthCheck(deployment.project, deployment.service)),
        ...(await this.remoteServers(deployment)),
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
    const live = await this.deps.prisma.deployment.findMany({
      where: { projectId, environmentId: null, status: DeploymentStatus.RUNNING, service: { type: "WEB", public: true } },
      include: { project: true, service: true },
    });
    for (const deployment of live) {
      const route = await this.routeFor(deployment.project, deployment);
      if (!route || !deployment.containerName || deployment.containerPort === null) continue;
      await this.deps.router.activate({
        ...route,
        deploymentId: deployment.id,
        containerName: deployment.containerName,
        containerPort: deployment.containerPort,
        ...replicaRouting(deployment.containerName, deployment.replicas, effectiveHealthCheck(deployment.project, deployment.service)),
        ...(await this.remoteServers(deployment)),
      });
    }
  }


  private async services(projectId: string): Promise<Service[]> {
    return this.deps.prisma.service.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  }

  /**
   * Where a deployment's service is routed in its environment, or null when it
   * isn't (workers, private services). Custom domains are production's only.
   */
  private async routeFor(
    project: Pick<Project, "id" | "slug">,
    deployment: Pick<Deployment, "serviceId" | "environmentId">,
  ): Promise<{ name: string; aliases: string[] } | null> {
    const services = await this.services(project.id);
    const service = services.find((candidate) => candidate.id === deployment.serviceId);
    if (!service || service.type !== "WEB" || !service.public) return null;
    const primaryId = primaryServiceId(services);
    const environment = deployment.environmentId
      ? await this.deps.prisma.environment.findUnique({ where: { id: deployment.environmentId } })
      : null;
    return {
      name: environmentRouteName(environment, routeName(project, service, primaryId)),
      aliases: environment ? [] : await this.serviceDomains(project.id, service.id, primaryId),
    };
  }

  /** An environment of this project that is still active (a closed preview can't be deployed). */
  private async activeEnvironment(projectId: string, environmentId: string): Promise<Environment> {
    const environment = await this.deps.prisma.environment.findFirst({ where: { id: environmentId, projectId } });
    if (!environment) throw new NotFoundError(`Environment not found: ${environmentId}`);
    if (environment.status !== "ACTIVE") {
      throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, `The ${environment.name} environment is closed.`);
    }
    return environment;
  }

  /** A service's custom domains; domains without a service belong to the primary one. */
  private async serviceDomains(projectId: string, serviceId: string, primaryId: string | null): Promise<string[]> {
    const domains = await this.deps.prisma.projectDomain.findMany({
      where: { projectId, OR: [{ serviceId }, ...(serviceId === primaryId ? [{ serviceId: null }] : [])] },
      select: { hostname: true },
      orderBy: { hostname: "asc" },
    });
    return domains.map((domain) => domain.hostname);
  }


  /** Takes the deployment out of the router, if the route still points at it. */
  private async deactivateRoute(deployment: Pick<Deployment, "id" | "projectId" | "serviceId" | "environmentId">): Promise<void> {
    const project = await this.deps.prisma.project.findUnique({
      where: { id: deployment.projectId },
      select: { id: true, slug: true },
    });
    const route = project && (await this.routeFor(project, deployment));
    if (route) await this.deps.router.deactivate(route.name, deployment.id);
  }

  /** The deployment a rollback from this one would bring back, or null if there is none. */
  async rollbackCandidate(id: string, userId: string): Promise<Deployment | null> {
    const { deployment } = await this.deps.access.deployment(id, userId, OrgRole.VIEWER);
    try {
      return await this.findRollbackTarget(deployment);
    } catch (error) {
      if (error instanceof ConflictError) return null;
      throw error;
    }
  }

  /** Whether a deployment waits for approval, and how that was decided. */
  async approvalOf(id: string, userId: string): Promise<{ status: "NOT_REQUIRED" | "AWAITING" | "APPROVED" | "REJECTED"; decidedBy: string | null; decidedAt: Date | null }> {
    await this.deps.access.deployment(id, userId, OrgRole.VIEWER);
    const job = await this.deps.prisma.deployJob.findFirst({ where: { deploymentIds: { has: id } } });
    if (!job || (!job.decidedAt && job.status !== "AWAITING_APPROVAL")) return { status: "NOT_REQUIRED", decidedBy: null, decidedAt: null };
    const decider = job.decidedById ? await this.deps.prisma.user.findUnique({ where: { id: job.decidedById }, select: { login: true } }) : null;
    const status = job.status === "AWAITING_APPROVAL" ? "AWAITING" : job.status === "CANCELLED" && job.error === "Rejected" ? "REJECTED" : "APPROVED";
    return { status, decidedBy: decider?.login ?? null, decidedAt: job.decidedAt };
  }

  /** An ADMIN approves (it is queued) or rejects (its deployments fail) a deploy waiting for approval. */
  async decide(id: string, userId: string, approve: boolean): Promise<Deployment> {
    const { deployment, project } = await this.deps.access.deployment(id, userId, OrgRole.ADMIN);
    const job = await this.deps.prisma.deployJob.findFirst({ where: { deploymentIds: { has: id }, status: "AWAITING_APPROVAL" } });
    if (!job) throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "This deployment isn't waiting for approval.");
    const { count } = await this.deps.prisma.deployJob.updateMany({
      where: { id: job.id, status: "AWAITING_APPROVAL" },
      data: approve
        ? { status: "QUEUED", decidedById: userId, decidedAt: new Date() }
        : { status: "CANCELLED", decidedById: userId, decidedAt: new Date(), finishedAt: new Date(), error: "Rejected" },
    });
    if (count !== 1) throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "Someone else decided it just now.");
    const login = (await this.deps.prisma.user.findUnique({ where: { id: userId }, select: { login: true } }))?.login ?? "an admin";
    if (!approve) {
      for (const deploymentId of job.deploymentIds) await this.markFailed(deploymentId, `Rejected by ${login}.`, DeploymentStatus.QUEUED);
    }
    await this.deps.audit.record({
      action: approve ? "DEPLOYMENT_APPROVED" : "DEPLOYMENT_REJECTED",
      actorId: userId,
      project,
      metadata: { deploymentIds: job.deploymentIds.join(",") },
    });
    if (approve) this.kick();
    return this.load(deployment.id);
  }

  // ───────────────────────── the queue ─────────────────────────

  /** Wakes the executor: claims and runs queued jobs this process may run. */
  kick(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = this.pump()
      .catch((error: unknown) => this.deps.logger.error({ err: error }, "Could not run queued deploys"))
      .finally(() => {
        this.pumping = null;
        if (this.pumpAgain) {
          this.pumpAgain = false;
          this.kick();
        }
      });
    this.track(this.pumping);
  }

  private async pump(): Promise<void> {
    for (;;) {
      let claimedAny = false;
      for (const candidate of await this.claimable()) {
        const workerId = await this.chooseWorker(candidate);
        if (workerId === undefined) continue; // no worker for it right now
        const job = await this.claim(candidate.id, workerId);
        if (!job) continue;
        this.claimed += 1;
        claimedAny = true;
        const run = this.runJob(job).finally(() => {
          this.activeJobs.delete(job.id);
          void this.reportLoad(job.workerId);
          this.kick();
        });
        this.activeJobs.set(job.id, { workerId: job.workerId, run });
        this.track(run);
        void this.reportLoad(job.workerId);
      }
      if (!claimedAny) return;
    }
  }

  /** Jobs running here for a worker (this process orchestrates every job). */
  private jobsOn(workerId: string | null): number {
    return [...this.activeJobs.values()].filter((job) => job.workerId === workerId).length;
  }

  /**
   * The scheduler: which worker should run this job now. undefined = none now
   * (all busy, or its pinned worker is away). null = this machine, unregistered.
   *
   * - A project with volumes is pinned to the worker holding its data.
   * - A project running on a worker that is still ONLINE stays there (its
   *   services share a private network, which exists on one machine);
   *   if that worker is draining or offline, the project moves.
   * - Otherwise: the least busy eligible worker (see scheduler.ts).
   */
  private async chooseWorker(job: Pick<DeployJob, "projectId" | "deploymentIds">): Promise<string | null | undefined> {
    const { prisma } = this.deps;
    if (!this.localWorkerId) return this.jobsOn(null) < JOB_SLOTS_PER_WORKER ? null : undefined;
    const workers = (await prisma.worker.findMany({ where: { acceptsJobs: true } })).map((worker) => ({
      ...worker,
      runningJobs: this.jobsOn(worker.id),
    }));
    const services = await prisma.service.findMany({
      where: { deployments: { some: { id: { in: job.deploymentIds } } } },
      select: { memoryLimitMb: true },
    });
    const limits = services.map((service) => service.memoryLimitMb).filter((limit) => limit !== null);
    const needs = { memoryMb: limits.length > 0 ? Math.max(...limits) : null };
    const eligible = new Set(eligibleWorkers(workers, needs).map((worker) => worker.id));

    const pinned = await prisma.deployment.findFirst({
      where: { projectId: job.projectId, workerId: { not: null }, service: { volumes: { some: {} } } },
      orderBy: { createdAt: "desc" },
      select: { workerId: true },
    });
    if (pinned?.workerId) return eligible.has(pinned.workerId) ? pinned.workerId : undefined;

    const live = await prisma.deployment.findFirst({
      where: { projectId: job.projectId, status: DeploymentStatus.RUNNING, workerId: { not: null } },
      orderBy: { finishedAt: "desc" },
      select: { workerId: true },
    });
    const home = live?.workerId ? workers.find((worker) => worker.id === live.workerId) : undefined;
    if (home?.status === "ONLINE") return eligible.has(home.id) ? home.id : undefined;
    return pickWorker(workers, needs)?.id ?? undefined;
  }

  /**
   * Jobs that could start now: the oldest of each project environment
   * (FIFO per environment), highest priority across them, none whose
   * environment is already running a job or is held by a restart here.
   */
  private async claimable(): Promise<DeployJob[]> {
    const busy = [...this.busyProjects];
    const whole = [...this.busyWholeProjects];
    return this.deps.prisma.$queryRaw<DeployJob[]>`
      SELECT j.* FROM "deploy_jobs" j
      WHERE j."status" = 'QUEUED'
        AND j."lockKey" <> ALL(${busy}::text[])
        AND split_part(j."lockKey", '/', 1) <> ALL(${whole}::text[])
        AND NOT EXISTS (SELECT 1 FROM "deploy_jobs" r WHERE r."lockKey" = j."lockKey" AND r."status" = 'RUNNING')
        AND NOT EXISTS (
          SELECT 1 FROM "deploy_jobs" e
          WHERE e."lockKey" = j."lockKey" AND e."status" = 'QUEUED' AND e."createdAt" < j."createdAt"
        )
      ORDER BY j."priority" DESC, j."createdAt" ASC
      LIMIT 20`;
  }

  /**
   * Claims a job for a worker. SKIP LOCKED lets several processes claim at
   * once without waiting on each other; the partial unique index is the last
   * word on "one running per environment" (a lost race claims nothing).
   */
  private async claim(jobId: string, workerId: string | null): Promise<DeployJob | null> {
    try {
      const rows = await this.deps.prisma.$queryRaw<DeployJob[]>`
        UPDATE "deploy_jobs" SET "status" = 'RUNNING', "workerId" = ${workerId}::uuid, "attempts" = "attempts" + 1,
          "startedAt" = now(), "leaseExpiresAt" = now() + make_interval(secs => ${LEASE_SECONDS})
        WHERE "id" = (SELECT "id" FROM "deploy_jobs" WHERE "id" = ${jobId}::uuid AND "status" = 'QUEUED' FOR UPDATE SKIP LOCKED)
        RETURNING *`;
      return rows[0] ?? null;
    } catch (error) {
      if (String(error).includes("23505") || String(error).includes("deploy_jobs_one_running_per_key")) return null;
      throw error;
    }
  }

  /** Runs a claimed job's deployments in order, then records how it went. */
  private async runJob(job: DeployJob): Promise<void> {
    const { prisma, logger } = this.deps;
    const finish = (status: "SUCCEEDED" | "FAILED" | "CANCELLED", error: string | null = null) =>
      prisma.deployJob.updateMany({
        where: { id: job.id, status: "RUNNING" },
        data: { status, error, finishedAt: new Date(), leaseExpiresAt: null },
      });
    try {
      const project = await prisma.project.findUnique({ where: { id: job.projectId } });
      if (!project) return; // deleted: its jobs went with it
      const environment = job.environmentId ? await prisma.environment.findUnique({ where: { id: job.environmentId } }) : null;
      const rows = await prisma.deployment.findMany({ where: { id: { in: job.deploymentIds }, status: DeploymentStatus.QUEUED } });
      const deployments = job.deploymentIds.map((id) => rows.find((row) => row.id === id)).filter((row) => row !== undefined);
      if (environment && environment.status !== "ACTIVE") {
        for (const deployment of deployments) await this.markFailed(deployment.id, `The ${environment.name} environment was closed.`, DeploymentStatus.QUEUED);
        await finish("CANCELLED", "Environment closed");
        return;
      }
      if (deployments.length > 0) {
        await prisma.deployment.updateMany({ where: { id: { in: deployments.map((d) => d.id) } }, data: { workerId: job.workerId } });
        const onWorker = deployments.map((deployment) => ({ ...deployment, workerId: job.workerId }));
        await this.executeAll(project, onWorker, await this.services(project.id), job.notes, environment);
      }
      const outcome = await prisma.deployment.findMany({ where: { id: { in: job.deploymentIds } }, select: { status: true } });
      const failed = outcome.some((deployment) => deployment.status !== DeploymentStatus.RUNNING);
      await finish(failed ? "FAILED" : "SUCCEEDED", failed ? "A deployment failed" : null);
    } catch (error) {
      logger.error({ err: error, jobId: job.id }, "Deploy job crashed");
      await finish("FAILED", errorMessage(error)).catch(() => {});
    }
  }

  /** Extends the leases of the jobs this process is running. */
  async renewLeases(): Promise<void> {
    if (this.activeJobs.size === 0) return;
    await this.deps.prisma.$executeRaw`
      UPDATE "deploy_jobs" SET "leaseExpiresAt" = now() + make_interval(secs => ${LEASE_SECONDS})
      WHERE "id" = ANY(${[...this.activeJobs.keys()]}::uuid[]) AND "status" = 'RUNNING'`;
  }

  /**
   * Jobs whose lease ran out: their worker stopped responding (it crashed,
   * lost its network, or was switched off). Their unfinished deployments are
   * marked WORKER_LOST. If none had started a container yet, nothing can be
   * running twice, so the job is retried (a new job, on any worker), up to
   * 3 times; otherwise a person decides (redeploy or roll back).
   */
  async recoverLostJobs(now = new Date()): Promise<number> {
    const { prisma, logger } = this.deps;
    const lost = await prisma.deployJob.findMany({ where: { status: "RUNNING", leaseExpiresAt: { lt: now } } });
    for (const job of lost) {
      if (this.activeJobs.has(job.id)) continue; // ours and alive: renewLeases will catch up
      const { count } = await prisma.deployJob.updateMany({
        where: { id: job.id, status: "RUNNING", leaseExpiresAt: { lt: now } },
        data: { status: "FAILED", error: "WORKER_LOST", finishedAt: now, leaseExpiresAt: null },
      });
      if (count !== 1) continue;
      const deployments = await prisma.deployment.findMany({ where: { id: { in: job.deploymentIds } } });
      const unfinished = deployments.filter((d) => IN_PROGRESS_STATUSES.includes(d.status));
      for (const deployment of unfinished) {
        await this.markFailed(deployment.id, "WORKER_LOST: the worker running this deployment stopped responding.", deployment.status);
      }
      const safe = deployments.every((d) => !d.containerId) && job.attempts < MAX_JOB_ATTEMPTS;
      logger.warn({ jobId: job.id, workerId: job.workerId, retried: safe }, "Deploy job lost its worker");
      if (safe && unfinished.length > 0) {
        await this.deploy(job.projectId, null, job.trigger, {
          serviceIds: deployments.map((d) => d.serviceId),
          ...(job.environmentId && { environmentId: job.environmentId }),
          retryOf: job.id,
          preApproved: true, // it was approved (or didn't need to be) the first time
        }).catch((error: unknown) => logger.warn({ err: error, jobId: job.id }, "Could not retry the lost job"));
      }
    }
    return lost.length;
  }

  /** Keeps a worker's load current for the dashboard between heartbeats. */
  private async reportLoad(workerId: string | null): Promise<void> {
    if (!workerId) return;
    await this.deps.prisma.worker.update({ where: { id: workerId }, data: { runningJobs: this.jobsOn(workerId) } }).catch(() => {});
  }

  /** Jobs this machine's worker is running (for its heartbeat). */
  get runningJobs(): number {
    return this.jobsOn(this.localWorkerId);
  }

  /** Unscoped: for Shipyard's own work (verified pushes), never on a person's behalf. */
  private async loadProject(id: string): Promise<Project> {
    const project = await this.deps.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundError(`Project not found: ${id}`);
    return project;
  }

  /** Unscoped: only for re-reading a row whose access was already checked. */
  private async load(id: string): Promise<Deployment> {
    const deployment = await this.deps.prisma.deployment.findUnique({ where: { id } });
    if (!deployment) throw new NotFoundError(`Deployment not found: ${id}`);
    return deployment;
  }



  /**
   * For a restart, rollback or close: `key` is the project (production) or
   * project/environment (see lockKey()). Refused while a deploy job of it runs.
   */
  private async lockProject(key: string): Promise<void> {
    const running = await this.deps.prisma.deployJob.count({ where: { lockKey: key, status: "RUNNING" } });
    if (this.busyProjects.has(key) || running > 0) {
      throw new ConflictError(
        ErrorCode.DEPLOYMENT_IN_PROGRESS,
        "Another deployment or restart of this project is in progress. Wait for it to finish.",
      );
    }
    this.busyProjects.add(key);
  }

  private unlockProject(key: string): void {
    this.busyProjects.delete(key);
    this.busyWholeProjects.delete(key);
    this.kick(); // jobs held back by it may run now
  }

  /** Locks every environment of a project (deleting it, or one of its services). */
  private async lockWholeProject(projectId: string): Promise<void> {
    const running = await this.deps.prisma.deployJob.count({ where: { projectId, status: "RUNNING" } });
    if (running > 0 || this.busyWholeProjects.has(projectId) || [...this.busyProjects].some((key) => key === projectId || key.startsWith(`${projectId}/`))) {
      throw new ConflictError(
        ErrorCode.DEPLOYMENT_IN_PROGRESS,
        "A deployment of this project is in progress (in some environment). Wait for it to finish.",
      );
    }
    this.busyWholeProjects.add(projectId);
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


/** The deploy lock: one deploy/restart at a time per project environment (production = the project id). */
function lockKey(projectId: string, environmentId: string | null): string {
  return environmentId ? `${projectId}/${environmentId}` : projectId;
}

/** Base for image and container names: the environment's name is part of them. */
function deploymentArtifactName(project: Pick<Project, "slug">, service: Pick<Service, "name">, environment: Pick<Environment, "name"> | null): string {
  const base = artifactName(project, service);
  return environment ? `${environment.name}-${base}` : base;
}
