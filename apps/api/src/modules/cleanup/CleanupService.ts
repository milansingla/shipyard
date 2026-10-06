import type { PrismaClient } from "../../db/prisma.js";
import type { Logger } from "../../lib/logger.js";
import { DeploymentStatus } from "../../services/deployment/status.js";
import type { WorkspaceService } from "../../services/workspace/WorkspaceService.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import type { ProjectEnvironments } from "../environments/ProjectEnvironments.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Stopped deployments kept, per service and environment, as rollback targets. */
export const ROLLBACK_TARGETS_KEPT = 3;

export interface CleanupReport {
  failedContainers: number;
  oldRollbackTargets: number;
  expiredPreviews: number;
  workspaces: number;
  records: number;
}

export interface CleanupServiceDeps {
  prisma: PrismaClient;
  deployments: Pick<DeploymentService, "pruneArtifacts">;
  environments: Pick<ProjectEnvironments, "closeEnvironment">;
  workspace: Pick<WorkspaceService, "removeStale">;
  logger: Logger;
}

/**
 * Hourly cleanup of what is safe to remove:
 *
 * - containers and images of deployments that FAILED more than a day ago
 *   (their logs and history stay);
 * - stopped deployments beyond the newest 3 per service and environment
 *   (the rollback targets that are kept);
 * - previews whose pull request saw no deploy for 14 days;
 * - clone directories left by crashes (over 2 hours old);
 * - old records: finished worker calls (7 days), finished deploy jobs
 *   (30 days), resolved alerts (90 days).
 *
 * Never: a live or in-progress deployment, a kept rollback target, a volume.
 */
export class CleanupService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CleanupServiceDeps) {}

  start(intervalMs = HOUR): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.run().catch((error: unknown) => this.deps.logger.error({ err: error }, "Cleanup failed"));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(now = new Date()): Promise<CleanupReport> {
    const { prisma, deployments, logger } = this.deps;
    const report: CleanupReport = { failedContainers: 0, oldRollbackTargets: 0, expiredPreviews: 0, workspaces: 0, records: 0 };
    const prune = async (deployment: Parameters<typeof deployments.pruneArtifacts>[0], key: "failedContainers" | "oldRollbackTargets") => {
      try {
        if (await deployments.pruneArtifacts(deployment)) report[key] += 1;
      } catch (error) {
        logger.warn({ err: error, deploymentId: deployment.id }, "Could not remove a deployment's container");
      }
    };

    const failed = await prisma.deployment.findMany({
      where: { status: DeploymentStatus.FAILED, containerId: { not: null }, finishedAt: { lt: new Date(now.getTime() - DAY) } },
    });
    for (const deployment of failed) await prune(deployment, "failedContainers");

    const stopped = await prisma.deployment.findMany({
      where: { status: DeploymentStatus.STOPPED, containerId: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    const seen = new Map<string, number>();
    for (const deployment of stopped) {
      const key = `${deployment.serviceId}/${deployment.environmentId ?? "production"}`;
      const rank = (seen.get(key) ?? 0) + 1;
      seen.set(key, rank);
      if (rank > ROLLBACK_TARGETS_KEPT) await prune(deployment, "oldRollbackTargets");
    }

    const previews = await prisma.environment.findMany({ where: { type: "PREVIEW", status: "ACTIVE" }, include: { deployments: { orderBy: { createdAt: "desc" }, take: 1 } } });
    for (const { deployments: [latest], ...preview } of previews) {
      if ((latest?.createdAt ?? preview.createdAt).getTime() < now.getTime() - 14 * DAY) {
        await this.deps.environments.closeEnvironment(preview).then(
          () => void (report.expiredPreviews += 1),
          (error: unknown) => logger.warn({ err: error, environmentId: preview.id }, "Could not close an expired preview"),
        );
      }
    }

    report.workspaces = await this.deps.workspace.removeStale(2 * HOUR, now.getTime());

    const counts = await Promise.all([
      prisma.workerCall.deleteMany({ where: { status: { in: ["DONE", "FAILED"] }, finishedAt: { lt: new Date(now.getTime() - 7 * DAY) } } }),
      prisma.deployJob.deleteMany({ where: { status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] }, finishedAt: { lt: new Date(now.getTime() - 30 * DAY) } } }),
      prisma.alert.deleteMany({ where: { status: "RESOLVED", resolvedAt: { lt: new Date(now.getTime() - 90 * DAY) } } }),
    ]);
    report.records = counts.reduce((sum, { count }) => sum + count, 0);

    if (Object.values(report).some((n) => n > 0)) logger.info(report, "Cleanup removed what was safe to remove");
    return report;
  }
}
