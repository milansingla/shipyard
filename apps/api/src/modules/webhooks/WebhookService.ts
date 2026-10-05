import { type PrismaClient, isUniqueViolation } from "../../db/prisma.js";
import { errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import { parsePushEvent } from "./pushEvent.js";

export interface WebhookServiceDeps {
  prisma: PrismaClient;
  deployments: Pick<DeploymentService, "deployOnPush">;
  logger: Logger;
}

export interface WebhookResult {
  /** True when this delivery id was already handled: nothing was done again. */
  duplicate: boolean;
  outcome: string;
}

/**
 * Handles verified GitHub webhook deliveries. Idempotent: the delivery id is
 * recorded BEFORE acting, so a retried or redelivered webhook is recognised and
 * skipped. If handling fails, the record is removed so GitHub's retry can succeed.
 */
export class WebhookService {
  constructor(private readonly deps: WebhookServiceDeps) {}

  async handle(deliveryId: string, event: string, payload: unknown): Promise<WebhookResult> {
    try {
      await this.deps.prisma.webhookDelivery.create({ data: { id: deliveryId, event } });
    } catch (error) {
      if (isUniqueViolation(error)) return { duplicate: true, outcome: "already handled" };
      throw error;
    }

    let outcome: string;
    try {
      outcome = await this.dispatch(event, payload);
    } catch (error) {
      await this.deps.prisma.webhookDelivery.delete({ where: { id: deliveryId } }).catch(() => {});
      throw error;
    }

    await this.deps.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { outcome } });
    this.deps.logger.info({ deliveryId, event, outcome }, "GitHub webhook handled");
    return { duplicate: false, outcome };
  }

  /** Delivery records older than this are only noise. */
  async pruneDeliveries(olderThanDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const { count } = await this.deps.prisma.webhookDelivery.deleteMany({ where: { receivedAt: { lt: cutoff } } });
    return count;
  }

  private async dispatch(event: string, payload: unknown): Promise<string> {
    if (event === "ping") return "pong";
    if (event !== "push") return `ignored: Shipyard only acts on push events (got ${event})`;

    const push = parsePushEvent(payload);
    if (push.kind === "ignore") return `ignored: ${push.reason}`;
    const { owner, name, branch, commitSha } = push.target;

    // GitHub names are case-insensitive; the stored ones come from what the user typed.
    const projects = await this.deps.prisma.project.findMany({
      where: {
        repositoryOwner: { equals: owner, mode: "insensitive" },
        repositoryName: { equals: name, mode: "insensitive" },
        branch,
      },
      orderBy: { createdAt: "asc" },
    });
    if (projects.length === 0) return `ignored: no project deploys ${owner}/${name}@${branch}`;

    const results: string[] = [];
    for (const project of projects) {
      try {
        const result = await this.deps.deployments.deployOnPush(project.id);
        results.push(`${result.outcome === "started" ? "deploying" : "queued"} ${project.slug}`);
      } catch (error) {
        // One project's problem must not stop the others from deploying.
        this.deps.logger.warn({ err: error, projectId: project.id }, "Push deploy failed to start");
        results.push(`failed ${project.slug}: ${errorMessage(error)}`);
      }
    }
    return `${commitSha.slice(0, 7)} on ${branch}: ${results.join("; ")}`;
  }
}
