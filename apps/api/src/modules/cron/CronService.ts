import { type CronJob, type CronRun, OrgRole, type PrismaClient, type Project, isUniqueViolation } from "../../db/prisma.js";
import { nextRun, parseCron } from "../../lib/cron.js";
import { ConflictError, ErrorCode, NotFoundError, ValidationError, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { DeploymentStatus } from "../../services/deployment/status.js";
import { type ContainerResources, type OneOffContainerOptions, type OneOffResult, ShipyardLabel } from "../../services/docker/DockerService.js";
import { buildContainerName } from "../../services/docker/naming.js";
import type { AccessService } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";
import type { EnvironmentService } from "../environment/EnvironmentService.js";
import { artifactName, effectiveResources, projectNetworkName } from "../services/serviceRules.js";
import { type CreateCronJobInput, MAX_CRON_JOBS_PER_PROJECT, type UpdateCronJobInput } from "./cron.schemas.js";

/** Runs kept per job; older ones are deleted. */
export const KEPT_RUNS = 50;

/** What runs a job: Docker in production, a fake in tests. */
export interface CronRunner {
  runToCompletion(options: OneOffContainerOptions): Promise<OneOffResult>;
  removeContainer(reference: string): Promise<void>;
}

export interface CronServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  audit: Pick<AuditService, "record">;
  environment: Pick<EnvironmentService, "forDeployment"> | null;
  runner: CronRunner;
  logger: Logger;
  /** Runs at the same time, across all projects. Due jobs beyond it wait for the next tick. */
  maxConcurrentRuns?: number;
}

export interface CronJobView extends CronJob {
  serviceName: string;
  lastRun: Omit<CronRun, "output"> | null;
}

/**
 * Cron jobs: a command run on a schedule (UTC) in a short-lived container of
 * a service's live image, with the service's runtime variables, on the
 * project network. The database decides what is due (`nextRunAt`), and a job
 * is claimed with a conditional update, so each occurrence runs once even if
 * ticks overlap. Runs missed while Shipyard was down run once, not once per
 * missed occurrence. A run never overlaps the job's previous one.
 */
export class CronService {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<Promise<void>>();
  private readonly maxConcurrentRuns: number;

  constructor(private readonly deps: CronServiceDeps) {
    this.maxConcurrentRuns = deps.maxConcurrentRuns ?? 4;
  }

  // ───────────── API ─────────────

  async list(projectId: string, userId: string): Promise<CronJobView[]> {
    await this.deps.access.project(projectId, userId, OrgRole.VIEWER);
    const jobs = await this.deps.prisma.cronJob.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
      include: {
        service: { select: { name: true } },
        runs: { orderBy: { startedAt: "desc" }, take: 1, omit: { output: true } },
      },
    });
    return jobs.map(({ service, runs, ...job }) => ({ ...job, serviceName: service.name, lastRun: runs[0] ?? null }));
  }

  async create(projectId: string, userId: string, input: CreateCronJobInput): Promise<CronJob> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.ADMIN);
    const { prisma } = this.deps;
    await this.assertRunnableService(projectId, input.serviceId);
    if ((await prisma.cronJob.count({ where: { projectId } })) >= MAX_CRON_JOBS_PER_PROJECT) {
      throw new ValidationError(`A project can have at most ${MAX_CRON_JOBS_PER_PROJECT} cron jobs.`);
    }
    const enabled = input.enabled ?? true;
    try {
      const job = await prisma.cronJob.create({
        data: { projectId, ...input, enabled, nextRunAt: enabled ? this.next(input.schedule) : null },
      });
      await this.deps.audit.record({
        action: "CRON_JOB_CREATED",
        actorId: userId,
        project,
        metadata: { cronJob: job.name, schedule: job.schedule },
      });
      return job;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `This project already has a cron job named "${input.name}".`);
      throw error;
    }
  }

  async update(id: string, userId: string, input: UpdateCronJobInput): Promise<CronJob> {
    const { job, project } = await this.find(id, userId, OrgRole.ADMIN);
    const schedule = input.schedule ?? job.schedule;
    const enabled = input.enabled ?? job.enabled;
    const rescheduled = input.schedule !== undefined || input.enabled !== undefined;
    const updated = await this.deps.prisma.cronJob.update({
      where: { id },
      data: { ...input, ...(rescheduled && { nextRunAt: enabled ? this.next(schedule) : null }) },
    });
    await this.deps.audit.record({
      action: "CRON_JOB_CHANGED",
      actorId: userId,
      project,
      metadata: { cronJob: job.name, settings: Object.keys(input).sort().join(",") },
    });
    return updated;
  }

  /** A run in progress is left to finish; its record goes with the job. */
  async delete(id: string, userId: string): Promise<void> {
    const { job, project } = await this.find(id, userId, OrgRole.ADMIN);
    await this.deps.prisma.cronJob.delete({ where: { id } });
    await this.deps.audit.record({ action: "CRON_JOB_DELETED", actorId: userId, project, metadata: { cronJob: job.name } });
  }

  /** Runs the job now, outside its schedule. Returns the run (RUNNING, or SKIPPED with the reason). */
  async runNow(id: string, userId: string): Promise<CronRun> {
    const { job, project } = await this.find(id, userId, OrgRole.DEVELOPER);
    const run = await this.launch(job, project, "MANUAL", null);
    await this.deps.audit.record({ action: "CRON_JOB_RUN", actorId: userId, project, metadata: { cronJob: job.name, runId: run.id, status: run.status } });
    return run;
  }

  async runs(id: string, userId: string, limit: number): Promise<Array<Omit<CronRun, "output">>> {
    await this.find(id, userId, OrgRole.VIEWER);
    return this.deps.prisma.cronRun.findMany({ where: { cronJobId: id }, orderBy: { startedAt: "desc" }, take: limit, omit: { output: true } });
  }

  async run(runId: string, userId: string): Promise<CronRun> {
    const run = await this.deps.prisma.cronRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundError(`Cron run not found: ${runId}`);
    await this.find(run.cronJobId, userId, OrgRole.VIEWER).catch((error: unknown) => {
      throw error instanceof NotFoundError ? new NotFoundError(`Cron run not found: ${runId}`) : error;
    });
    return run;
  }

  // ───────────── scheduler ─────────────

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.deps.logger.error({ err: error }, "Cron tick failed"));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts every due job (up to the concurrency limit). Returns how many runs it started. */
  async tick(now = new Date()): Promise<number> {
    const { prisma } = this.deps;
    const free = this.maxConcurrentRuns - this.running.size;
    if (free <= 0) return 0;
    const due = await prisma.cronJob.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: "asc" },
      take: free,
      include: { project: true },
    });
    let started = 0;
    for (const { project, ...job } of due) {
      // Claim this occurrence: only one tick (or process) wins it. The next occurrence is
      // computed from now, so a backlog of missed ones collapses into this single run.
      const claimed = await prisma.cronJob.updateMany({
        where: { id: job.id, nextRunAt: job.nextRunAt },
        data: { nextRunAt: this.next(job.schedule, now) },
      });
      if (claimed.count !== 1) continue;
      await this.launch(job, project, "SCHEDULE", job.nextRunAt);
      started += 1;
    }
    return started;
  }

  /** Runs still marked RUNNING from before a restart: their container is gone with the process that watched it. */
  async reconcileOnStartup(): Promise<number> {
    const stale = await this.deps.prisma.cronRun.findMany({ where: { status: "RUNNING" } });
    for (const run of stale) {
      if (run.containerName) await this.deps.runner.removeContainer(run.containerName).catch(() => {});
      await this.deps.prisma.cronRun.update({
        where: { id: run.id },
        data: { status: "FAILED", finishedAt: new Date(), errorMessage: "Interrupted: Shipyard restarted while it ran." },
      });
    }
    return stale.length;
  }

  /** Resolves when every run started so far has finished (tests, shutdown). */
  async waitForIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  // ───────────── internals ─────────────

  private async launch(job: CronJob, project: Project, trigger: "SCHEDULE" | "MANUAL", scheduledFor: Date | null): Promise<CronRun> {
    const { prisma } = this.deps;
    const skip = (reason: string) =>
      prisma.cronRun.create({
        data: { cronJobId: job.id, trigger, scheduledFor, status: "SKIPPED", finishedAt: new Date(), errorMessage: reason },
      });

    if (await prisma.cronRun.findFirst({ where: { cronJobId: job.id, status: "RUNNING" }, select: { id: true } })) {
      return skip("The previous run was still running.");
    }
    const service = await prisma.service.findUniqueOrThrow({ where: { id: job.serviceId } });
    const deployment = await prisma.deployment.findFirst({
      where: { serviceId: job.serviceId, environmentId: null, status: DeploymentStatus.RUNNING },
      orderBy: { finishedAt: "desc" },
    });
    if (!deployment) return skip(`Nothing to run: ${service.name} has no running deployment. Deploy it first.`);

    const run = await prisma.cronRun.create({ data: { cronJobId: job.id, trigger, scheduledFor, deploymentId: deployment.id, status: "RUNNING" } });
    const containerName = buildContainerName(`${artifactName(project, service)}-${job.name}`, run.id);
    await prisma.cronRun.update({ where: { id: run.id }, data: { containerName } });

    const execution = this.execute(job, run.id, {
      imageName: deployment.imageName!,
      containerName,
      command: ["sh", "-c", job.command],
      network: projectNetworkName(project.id),
      labels: { [ShipyardLabel.PROJECT_ID]: project.id, "shipyard.cron-job": job.id, "shipyard.cron-run": run.id },
      resources: effectiveResources(project, service) as ContainerResources,
      timeoutMs: job.timeoutSeconds * 1000,
      env: {},
    }).finally(() => this.running.delete(execution));
    this.running.add(execution);
    return { ...run, containerName };
  }

  private async execute(job: CronJob, runId: string, options: OneOffContainerOptions): Promise<void> {
    const { prisma, logger } = this.deps;
    try {
      const env = this.deps.environment ? (await this.deps.environment.forDeployment(job.projectId, job.serviceId)).runtime : {};
      const result = await this.deps.runner.runToCompletion({ ...options, env });
      const status = result.timedOut ? "TIMED_OUT" : result.exitCode === 0 ? "SUCCEEDED" : "FAILED";
      await prisma.cronRun.update({
        where: { id: runId },
        data: {
          status,
          exitCode: result.exitCode,
          output: result.output,
          finishedAt: new Date(),
          errorMessage: result.timedOut
            ? `Killed after ${job.timeoutSeconds}s (its timeout).`
            : result.oomKilled
              ? "Killed: it ran out of memory."
              : result.exitCode === 0
                ? null
                : `Exited with code ${result.exitCode}.`,
        },
      });
      logger.info({ cronJobId: job.id, runId, status, exitCode: result.exitCode }, "Cron run finished");
    } catch (error) {
      logger.warn({ err: error, cronJobId: job.id, runId }, "Cron run failed to run");
      await prisma.cronRun
        .update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), errorMessage: errorMessage(error) } })
        .catch(() => {});
    } finally {
      await this.prune(job.id).catch(() => {});
    }
  }

  private async prune(cronJobId: string): Promise<void> {
    const old = await this.deps.prisma.cronRun.findMany({
      where: { cronJobId },
      orderBy: { startedAt: "desc" },
      skip: KEPT_RUNS,
      select: { id: true },
    });
    if (old.length > 0) await this.deps.prisma.cronRun.deleteMany({ where: { id: { in: old.map((run) => run.id) } } });
  }

  private next(schedule: string, after = new Date()): Date | null {
    return nextRun(parseCron(schedule), after);
  }

  /** Jobs run a web service's or worker's image; a database has no command to run. */
  private async assertRunnableService(projectId: string, serviceId: string): Promise<void> {
    const service = await this.deps.prisma.service.findFirst({ where: { id: serviceId, projectId } });
    if (!service) throw new ValidationError("serviceId must be a service of this project.");
    if (service.type === "POSTGRES") throw new ValidationError("A cron job runs in a web service's or worker's image, not a database's.");
  }

  private async find(id: string, userId: string, need: OrgRole) {
    const job = await this.deps.prisma.cronJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundError(`Cron job not found: ${id}`);
    try {
      return { job, project: await this.deps.access.project(job.projectId, userId, need) };
    } catch (error) {
      throw error instanceof NotFoundError ? new NotFoundError(`Cron job not found: ${id}`) : error;
    }
  }
}
