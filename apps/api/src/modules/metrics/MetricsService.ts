import { OrgRole, type PrismaClient } from "../../db/prisma.js";
import type { Logger } from "../../lib/logger.js";
import { DeploymentStatus } from "../../services/deployment/status.js";
import type { ContainerStats } from "../../services/docker/DockerService.js";
import type { AccessService } from "../access/AccessService.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";

/** Samples are kept this long. */
const RETENTION_MS = 24 * 60 * 60 * 1000;
/** The charts show this much history. */
const SERIES_MS = 60 * 60 * 1000;

export interface MetricsServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  deployments: Pick<DeploymentService, "statsFor">;
  logger: Logger;
}

export interface ServiceMetrics {
  serviceId: string;
  name: string;
  deploymentId: string | null;
  status: DeploymentStatus | null;
  /** Replicas the deployment asked for / are running now. */
  replicas: number;
  running: number;
  cpuPercent: number | null;
  memoryMb: number | null;
  memoryLimitMb: number | null;
  restartCount: number | null;
  /** Since the oldest replica started; null when nothing runs. */
  uptimeSeconds: number | null;
  /** The last hour, oldest first. */
  series: Array<{ at: Date; cpuPercent: number; memoryMb: number }>;
}

export interface ProjectMetrics {
  services: ServiceMetrics[];
  /** Production deployments of the last 30 days. */
  deployments: {
    total: number;
    succeeded: number;
    failed: number;
    /** 0–1; null when none finished. */
    successRate: number | null;
    /** Start to RUNNING, successful ones. */
    averageDeployMs: number | null;
    /** Time in BUILDING, from the history of the successful ones. */
    averageBuildMs: number | null;
  };
}

/**
 * Basic observability: CPU, memory, restarts and uptime of running
 * deployments, sampled every 30 s from the worker running them and kept for
 * 24 h; deployment success rate and durations from the deployment history.
 */
export class MetricsService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MetricsServiceDeps) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sample().catch((error: unknown) => this.deps.logger.warn({ err: error }, "Metrics sampling failed"));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Samples every RUNNING deployment once; drops samples past retention. Returns how many it stored. */
  async sample(now = new Date()): Promise<number> {
    const { prisma, logger } = this.deps;
    const running = await prisma.deployment.findMany({
      where: { status: DeploymentStatus.RUNNING, containerId: { not: null } },
      select: { id: true, projectId: true, serviceId: true, workerId: true, containerId: true },
    });
    let stored = 0;
    for (const deployment of running) {
      try {
        const replicas = await this.deps.deployments.statsFor(deployment);
        if (replicas.length === 0) continue;
        await prisma.metricSample.create({
          data: { deploymentId: deployment.id, projectId: deployment.projectId, serviceId: deployment.serviceId, ...aggregate(replicas), at: now },
        });
        stored += 1;
      } catch (error) {
        logger.debug({ err: error, deploymentId: deployment.id }, "Could not sample a deployment");
      }
    }
    await prisma.metricSample.deleteMany({ where: { at: { lt: new Date(now.getTime() - RETENTION_MS) } } });
    return stored;
  }

  async forProject(projectId: string, userId: string, now = new Date()): Promise<ProjectMetrics> {
    await this.deps.access.project(projectId, userId, OrgRole.VIEWER);
    const { prisma } = this.deps;
    const services = await prisma.service.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    const result: ServiceMetrics[] = [];
    for (const service of services) {
      const live = await prisma.deployment.findFirst({
        where: { serviceId: service.id, environmentId: null, status: DeploymentStatus.RUNNING },
        orderBy: { finishedAt: "desc" },
      });
      let current: ReturnType<typeof aggregate> | null = null;
      let startedAt: number | null = null;
      if (live) {
        // Fresh numbers when the worker answers; the last sample otherwise.
        const replicas = await this.deps.deployments.statsFor(live).catch(() => [] as ContainerStats[]);
        if (replicas.length > 0) {
          current = aggregate(replicas);
          const starts = replicas.map((r) => (r.startedAt ? Date.parse(r.startedAt) : NaN)).filter((t) => !Number.isNaN(t));
          startedAt = starts.length > 0 ? Math.min(...starts) : null;
        } else {
          const last = await prisma.metricSample.findFirst({ where: { deploymentId: live.id }, orderBy: { at: "desc" } });
          if (last) {
            current = {
              cpuPercent: round(last.cpuPercent),
              memoryMb: round(last.memoryMb),
              memoryLimitMb: last.memoryLimitMb,
              restartCount: last.restartCount,
              running: last.running,
            };
          }
          // Running since it went live (a restart since then isn't visible without the worker).
          startedAt = live.finishedAt?.getTime() ?? null;
        }
      }
      const series = live
        ? await prisma.metricSample.findMany({
            where: { deploymentId: live.id, at: { gte: new Date(now.getTime() - SERIES_MS) } },
            orderBy: { at: "asc" },
            select: { at: true, cpuPercent: true, memoryMb: true },
          })
        : [];
      result.push({
        serviceId: service.id,
        name: service.name,
        deploymentId: live?.id ?? null,
        status: live?.status ?? null,
        replicas: live?.replicas ?? 0,
        running: current?.running ?? 0,
        cpuPercent: current?.cpuPercent ?? null,
        memoryMb: current?.memoryMb ?? null,
        memoryLimitMb: current?.memoryLimitMb ?? null,
        restartCount: current?.restartCount ?? null,
        uptimeSeconds: startedAt === null ? null : Math.max(0, Math.round((now.getTime() - startedAt) / 1000)),
        series,
      });
    }
    return { services: result, deployments: await this.history(projectId, now) };
  }

  private async history(projectId: string, now: Date): Promise<ProjectMetrics["deployments"]> {
    const { prisma } = this.deps;
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const deployments = await prisma.deployment.findMany({
      where: { projectId, environmentId: null, createdAt: { gte: since } },
      select: { id: true, status: true, startedAt: true, finishedAt: true, events: { select: { toStatus: true, createdAt: true }, orderBy: { id: "asc" } } },
    });
    // Reached RUNNING at some point (it may have been replaced since).
    const succeeded = deployments.filter((d) => d.events.some((e) => e.toStatus === DeploymentStatus.RUNNING));
    const failed = deployments.filter((d) => d.status === DeploymentStatus.FAILED && !succeeded.includes(d));
    const deployTimes = succeeded
      .map((d) => {
        const running = d.events.find((e) => e.toStatus === DeploymentStatus.RUNNING);
        return d.startedAt && running ? running.createdAt.getTime() - d.startedAt.getTime() : null;
      })
      .filter((ms): ms is number => ms !== null && ms >= 0);
    const buildTimes = succeeded
      .map((d) => {
        const building = d.events.findIndex((e) => e.toStatus === DeploymentStatus.BUILDING);
        const after = building >= 0 ? d.events[building + 1] : undefined;
        return building >= 0 && after ? after.createdAt.getTime() - d.events[building]!.createdAt.getTime() : null;
      })
      .filter((ms): ms is number => ms !== null && ms >= 0);
    const finished = succeeded.length + failed.length;
    return {
      total: deployments.length,
      succeeded: succeeded.length,
      failed: failed.length,
      successRate: finished > 0 ? succeeded.length / finished : null,
      averageDeployMs: average(deployTimes),
      averageBuildMs: average(buildTimes),
    };
  }
}

/** One number per deployment: CPU and memory summed over replicas. */
export function aggregate(replicas: readonly ContainerStats[]) {
  const limits = replicas.map((r) => r.memoryLimitMb);
  return {
    cpuPercent: round(replicas.reduce((sum, r) => sum + r.cpuPercent, 0)),
    memoryMb: round(replicas.reduce((sum, r) => sum + r.memoryMb, 0)),
    memoryLimitMb: limits.every((limit) => limit !== null) ? round(limits.reduce((sum, limit) => sum! + limit!, 0)!) : null,
    restartCount: replicas.reduce((sum, r) => sum + r.restartCount, 0),
    running: replicas.filter((r) => r.running).length,
  };
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
