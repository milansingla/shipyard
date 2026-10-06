import { randomUUID } from "node:crypto";

import { type Alert, type NotificationChannel, OrgRole, type PrismaClient, isUniqueViolation } from "../../db/prisma.js";
import { AppError, ErrorCode, ForbiddenError, NotFoundError, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { SecretBox } from "../../lib/secretBox.js";
import { DeploymentStatus } from "../../services/deployment/status.js";
import type { Notification, NotificationProvider, UrlGuard } from "../../services/notify/NotificationProvider.js";
import type { AccessService } from "../access/AccessService.js";

/** Five samples (2.5 min) above the line before CPU or memory alerts open. */
const SUSTAINED_SAMPLES = 5;
const CPU_THRESHOLD = 0.9;
const MEMORY_THRESHOLD = 0.9;
/** Free disk below this (percent) on a worker opens DISK_PRESSURE. */
const DISK_FREE_THRESHOLD = 10;

export interface AlertServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  /** Encrypts channel URLs (a Slack webhook URL is a credential); null = channels unavailable. */
  secretBox: SecretBox | null;
  providers: Record<NotificationChannel["type"], NotificationProvider>;
  guard: UrlGuard;
  /** Platform administrators (worker alerts and platform channels). */
  isAdmin: (login: string) => boolean;
  /** The dashboard, for links in notifications. */
  appUrl: string;
  logger: Logger;
}

export type ChannelView = Omit<NotificationChannel, "url">;

interface RaiseInput {
  kind: Alert["kind"];
  severity: Alert["severity"];
  fingerprint: string;
  title: string;
  message: string;
  organizationId: string | null;
  projectId?: string | null;
}

/**
 * Alerts: something wrong, raised once (an open alert with the same
 * fingerprint is reused) and resolved when it clears, with the
 * organization's channels told both times. Alerting knows nothing about
 * Slack or webhooks: it hands notifications to a NotificationProvider.
 *
 * Raised by events (a production deployment failed, a worker went offline)
 * and by evaluate(), which reads the metric samples: an app not running,
 * CPU or memory above 90% of its limit for 2.5 minutes, a worker's disk
 * under 10% free.
 */
export class AlertService {
  private timer: NodeJS.Timeout | null = null;
  private readonly sending = new Set<Promise<unknown>>();

  constructor(private readonly deps: AlertServiceDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.evaluate().catch((error: unknown) => this.deps.logger.error({ err: error }, "Alert evaluation failed"));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once every notification sent so far has been delivered (or failed). */
  async waitForIdle(): Promise<void> {
    while (this.sending.size > 0) await Promise.allSettled([...this.sending]);
  }

  // ───────────── channels ─────────────

  async listChannels(organizationId: string | null, user: { id: string; login: string }): Promise<ChannelView[]> {
    await this.assertManager(organizationId, user);
    const channels = await this.deps.prisma.notificationChannel.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
    return channels.map(view);
  }

  async createChannel(
    organizationId: string | null,
    user: { id: string; login: string },
    input: { name: string; type: NotificationChannel["type"]; url: string },
  ): Promise<ChannelView> {
    await this.assertManager(organizationId, user);
    const box = this.box();
    const host = this.deps.guard.parse(input.url);
    await this.deps.guard.check(input.url);
    const id = randomUUID();
    const channel = await this.deps.prisma.notificationChannel.create({
      data: { id, organizationId, name: input.name, type: input.type, host, url: box.encrypt(input.url, sealContext(id)) },
    });
    return view(channel);
  }

  async deleteChannel(channelId: string, user: { id: string; login: string }): Promise<void> {
    const channel = await this.channel(channelId, user);
    await this.deps.prisma.notificationChannel.delete({ where: { id: channel.id } });
  }

  /** Sends a test notification now, and says how it went. */
  async testChannel(channelId: string, user: { id: string; login: string }): Promise<ChannelView> {
    const channel = await this.channel(channelId, user);
    await this.deliver(channel, {
      kind: "TEST",
      severity: "WARNING",
      status: "OPEN",
      title: "Test notification",
      message: `Shipyard can reach the channel "${channel.name}".`,
      project: null,
      url: this.deps.appUrl,
      at: new Date().toISOString(),
    });
    return view(await this.deps.prisma.notificationChannel.findUniqueOrThrow({ where: { id: channel.id } }));
  }

  // ───────────── alerts ─────────────

  /** Alerts of the user's organizations (and the platform's, for administrators), newest first. */
  async list(user: { id: string; login: string }, filter: { status?: Alert["status"]; limit: number }): Promise<Alert[]> {
    const memberships = await this.deps.prisma.membership.findMany({ where: { userId: user.id }, select: { organizationId: true } });
    const organizations = memberships.map((membership) => membership.organizationId);
    return this.deps.prisma.alert.findMany({
      where: {
        ...(filter.status && { status: filter.status }),
        OR: [{ organizationId: { in: organizations } }, ...(this.deps.isAdmin(user.login) ? [{ organizationId: null }] : [])],
      },
      orderBy: { openedAt: "desc" },
      take: filter.limit,
    });
  }

  /** Opens an alert unless one with this fingerprint is open. Returns it, or null if it was already open. */
  async raise(input: RaiseInput): Promise<Alert | null> {
    if (await this.deps.prisma.alert.findFirst({ where: { fingerprint: input.fingerprint, status: "OPEN" }, select: { id: true } })) return null;
    let alert: Alert;
    try {
      alert = await this.deps.prisma.alert.create({ data: { ...input, projectId: input.projectId ?? null } });
    } catch (error) {
      if (isUniqueViolation(error)) return null; // raised by someone else meanwhile
      throw error;
    }
    this.deps.logger.warn({ kind: alert.kind, fingerprint: alert.fingerprint }, `Alert: ${alert.title}`);
    this.notify(alert, "OPEN");
    return alert;
  }

  async resolve(fingerprint: string): Promise<number> {
    const open = await this.deps.prisma.alert.findMany({ where: { fingerprint, status: "OPEN" } });
    for (const alert of open) {
      const { count } = await this.deps.prisma.alert.updateMany({ where: { id: alert.id, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: new Date() } });
      if (count === 1) this.notify({ ...alert, status: "RESOLVED" }, "RESOLVED");
    }
    return open.length;
  }

  /** A production deployment finished: a failure opens an alert for its service; a success resolves it. */
  async deploymentFinished(input: {
    deployment: { id: string; status: string; serviceId: string; environmentId: string | null; errorMessage: string | null };
    project: { id: string; name: string; organizationId: string };
    serviceName: string;
  }): Promise<void> {
    const { deployment, project, serviceName } = input;
    if (deployment.environmentId) return; // previews and development don't page anyone
    const fingerprint = `DEPLOYMENT_FAILED:${deployment.serviceId}`;
    if (deployment.status === DeploymentStatus.RUNNING) {
      await this.resolve(fingerprint);
      return;
    }
    await this.raise({
      kind: "DEPLOYMENT_FAILED",
      severity: "WARNING",
      fingerprint,
      title: `${project.name}: deploying ${serviceName} failed`,
      message: deployment.errorMessage ?? "The deployment failed.",
      organizationId: project.organizationId,
      projectId: project.id,
    });
  }

  async workerOffline(workerIds: readonly string[]): Promise<void> {
    for (const worker of await this.deps.prisma.worker.findMany({ where: { id: { in: [...workerIds] } } })) {
      await this.raise({
        kind: "WORKER_OFFLINE",
        severity: "CRITICAL",
        fingerprint: `WORKER_OFFLINE:${worker.id}`,
        title: `Worker ${worker.name} is offline`,
        message: `No heartbeat from ${worker.hostname} since ${worker.lastHeartbeatAt.toISOString()}. Its deployments may be down.`,
        organizationId: null,
      });
    }
  }

  async workerOnline(workerId: string): Promise<void> {
    await this.resolve(`WORKER_OFFLINE:${workerId}`);
  }

  /** Checks the latest metric samples and worker reports; opens and resolves what changed. */
  async evaluate(): Promise<{ opened: number; resolved: number }> {
    const { prisma } = this.deps;
    let opened = 0;
    let resolved = 0;
    const count = async (raised: Promise<Alert | null>) => void ((await raised) && (opened += 1));

    const live = await prisma.deployment.findMany({
      where: { status: DeploymentStatus.RUNNING, environmentId: null },
      include: { project: { select: { id: true, name: true, organizationId: true, cpuLimit: true } }, service: { select: { name: true, cpuLimit: true } } },
    });
    for (const deployment of live) {
      const samples = await prisma.metricSample.findMany({ where: { deploymentId: deployment.id }, orderBy: { at: "desc" }, take: SUSTAINED_SAMPLES });
      const latest = samples[0];
      if (!latest) continue;
      const where = `${deployment.project.name}/${deployment.service.name}`;
      const base = { organizationId: deployment.project.organizationId, projectId: deployment.project.id };

      // Not running: crashed, or crash-looping under its restart policy.
      const down = `APP_DOWN:${deployment.id}`;
      if (latest.running < deployment.replicas) {
        await count(
          this.raise({
            kind: "APP_DOWN",
            severity: "CRITICAL",
            fingerprint: down,
            title: `${where} is down`,
            message: `${latest.running} of ${deployment.replicas} replica(s) running (${latest.restartCount} restart(s)).`,
            ...base,
          }),
        );
      } else resolved += await this.resolve(down);

      const sustained = samples.length === SUSTAINED_SAMPLES;
      const cpuLine = CPU_THRESHOLD * 100 * (deployment.service.cpuLimit ?? deployment.project.cpuLimit ?? 1) * deployment.replicas;
      const cpu = `HIGH_CPU:${deployment.id}`;
      if (sustained && samples.every((s) => s.cpuPercent > cpuLine)) {
        await count(
          this.raise({
            kind: "HIGH_CPU",
            severity: "WARNING",
            fingerprint: cpu,
            title: `${where}: high CPU`,
            message: `${Math.round(latest.cpuPercent)}% for the last ${SUSTAINED_SAMPLES} samples (over ${Math.round(cpuLine)}%).`,
            ...base,
          }),
        );
      } else if (latest.cpuPercent <= cpuLine) resolved += await this.resolve(cpu);

      const memory = `HIGH_MEMORY:${deployment.id}`;
      if (latest.memoryLimitMb && sustained && samples.every((s) => s.memoryLimitMb && s.memoryMb > MEMORY_THRESHOLD * s.memoryLimitMb)) {
        await count(
          this.raise({
            kind: "HIGH_MEMORY",
            severity: "WARNING",
            fingerprint: memory,
            title: `${where}: memory nearly full`,
            message: `${Math.round(latest.memoryMb)} of ${Math.round(latest.memoryLimitMb)} MB; past the limit, it is killed.`,
            ...base,
          }),
        );
      } else if (!latest.memoryLimitMb || latest.memoryMb <= MEMORY_THRESHOLD * latest.memoryLimitMb) resolved += await this.resolve(memory);
    }

    // Alerts about deployments that aren't running any more resolve themselves.
    const liveIds = new Set(live.map((deployment) => deployment.id));
    const stale = await prisma.alert.findMany({ where: { status: "OPEN", kind: { in: ["APP_DOWN", "HIGH_CPU", "HIGH_MEMORY"] } }, select: { fingerprint: true } });
    for (const { fingerprint } of stale) if (!liveIds.has(fingerprint.split(":")[1]!)) resolved += await this.resolve(fingerprint);

    for (const worker of await prisma.worker.findMany({ where: { status: { not: "OFFLINE" } } })) {
      const fingerprint = `DISK_PRESSURE:${worker.id}`;
      if (worker.diskFreePercent !== null && worker.diskFreePercent < DISK_FREE_THRESHOLD) {
        await count(
          this.raise({
            kind: "DISK_PRESSURE",
            severity: "CRITICAL",
            fingerprint,
            title: `Worker ${worker.name} is running out of disk`,
            message: `${Math.round(worker.diskFreePercent)}% free. Builds and volumes fail when it is full; prune old images (docker image prune).`,
            organizationId: null,
          }),
        );
      } else resolved += await this.resolve(fingerprint);
    }
    return { opened, resolved };
  }

  // ───────────── delivery ─────────────

  private notify(alert: Alert, status: "OPEN" | "RESOLVED"): void {
    const sending = this.send(alert, status).catch((error: unknown) => this.deps.logger.error({ err: error }, "Could not send alert"));
    this.sending.add(sending);
    void sending.finally(() => this.sending.delete(sending));
  }

  private async send(alert: Alert, status: "OPEN" | "RESOLVED"): Promise<void> {
    if (!this.deps.secretBox) return;
    const { prisma } = this.deps;
    const channels = await prisma.notificationChannel.findMany({ where: { organizationId: alert.organizationId, enabled: true } });
    if (channels.length === 0) return;
    const project = alert.projectId ? await prisma.project.findUnique({ where: { id: alert.projectId }, select: { id: true, name: true } }) : null;
    const notification: Notification = {
      kind: alert.kind,
      severity: alert.severity,
      status,
      title: alert.title,
      message: alert.message,
      project,
      url: project ? `${this.deps.appUrl}/projects/${project.id}` : `${this.deps.appUrl}/alerts`,
      at: new Date().toISOString(),
    };
    for (const channel of channels) await this.deliver(channel, notification).catch(() => {});
  }

  /** Sends one notification; records the outcome on the channel. Throws if it failed. */
  private async deliver(channel: NotificationChannel, notification: Notification): Promise<void> {
    const url = this.box().decrypt(channel.url, sealContext(channel.id));
    try {
      await this.deps.providers[channel.type].send(url, notification);
      await this.deps.prisma.notificationChannel.update({ where: { id: channel.id }, data: { lastSentAt: new Date(), lastError: null } });
    } catch (error) {
      const message = errorMessage(error);
      this.deps.logger.warn({ channelId: channel.id, reason: message }, "Notification not delivered");
      await this.deps.prisma.notificationChannel.update({ where: { id: channel.id }, data: { lastError: message.slice(0, 500) } });
      throw error;
    }
  }

  private async channel(channelId: string, user: { id: string; login: string }): Promise<NotificationChannel> {
    const channel = await this.deps.prisma.notificationChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundError(`Channel not found: ${channelId}`);
    await this.assertManager(channel.organizationId, user).catch((error: unknown) => {
      throw error instanceof ForbiddenError && channel.organizationId ? new NotFoundError(`Channel not found: ${channelId}`) : error;
    });
    return channel;
  }

  /** Organization channels: its ADMINs. Platform channels (null): SHIPYARD_ADMINS. */
  private async assertManager(organizationId: string | null, user: { id: string; login: string }): Promise<void> {
    if (organizationId === null) {
      if (!this.deps.isAdmin(user.login)) throw new ForbiddenError("Only platform administrators (SHIPYARD_ADMINS) manage platform channels.");
      return;
    }
    await this.deps.access.organization(organizationId, user.id, OrgRole.ADMIN);
  }

  private box(): SecretBox {
    if (!this.deps.secretBox) {
      throw new AppError(ErrorCode.CONFIG_INVALID, "Notification channels need SHIPYARD_SECRET_KEY (their URLs are stored encrypted).", { statusCode: 503 });
    }
    return this.deps.secretBox;
  }
}

function view({ url: _url, ...channel }: NotificationChannel): ChannelView {
  return channel;
}

function sealContext(channelId: string): string {
  return `channel:${channelId}`;
}
