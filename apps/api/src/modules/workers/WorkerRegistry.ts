import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { PrismaClient, Worker } from "../../db/prisma.js";
import { AppError, ErrorCode, ForbiddenError, NotFoundError, UnauthenticatedError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";

/** A worker that hasn't heartbeated for this long is OFFLINE. */
export const HEARTBEAT_TIMEOUT_MS = 45_000;
/** How often workers are told to heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

const TOKEN_PREFIX = "shpw_";

export interface WorkerInfo {
  name: string;
  hostname: string;
  cpus: number;
  memoryMb: number;
  version: string;
}

export interface WorkerRegistryDeps {
  prisma: PrismaClient;
  /** null = no machine may register (only the built-in worker runs). */
  joinToken: string | null;
  /** Lower-cased GitHub logins allowed to see and drain workers. */
  admins: readonly string[];
  logger: Logger;
}

/** What the API shows: never the token hash. */
export type WorkerView = Omit<Worker, "tokenHash">;

/**
 * The machines that run deployments. A worker registers with the join token
 * and gets its own secret (shown once, stored as a hash), then heartbeats.
 * One that stops heartbeating is marked OFFLINE by sweep(). Platform
 * administrators (SHIPYARD_ADMINS) list workers and drain them: a DRAINING
 * worker finishes what it has and gets nothing new.
 */
export class WorkerRegistry {
  constructor(private readonly deps: WorkerRegistryDeps) {}

  /** Registers (or re-registers, replacing its secret) a worker. Returns the secret once. */
  async register(joinToken: string | null, info: WorkerInfo): Promise<{ worker: WorkerView; token: string }> {
    if (!this.deps.joinToken) {
      throw new AppError(ErrorCode.AUTH_NOT_CONFIGURED, "This server doesn't accept workers: SHIPYARD_WORKER_JOIN_TOKEN isn't set.", {
        statusCode: 503,
      });
    }
    if (!joinToken || !sameSecret(joinToken, this.deps.joinToken)) throw new UnauthenticatedError("Invalid worker join token.");
    const existing = await this.deps.prisma.worker.findUnique({ where: { name: info.name } });
    if (existing?.builtIn) throw new ForbiddenError(`"${info.name}" is the control plane's own worker. Pick another SHIPYARD_WORKER_NAME.`);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const data = { ...info, tokenHash: hash(token), status: "ONLINE" as const, lastHeartbeatAt: new Date() };
    const worker = await this.deps.prisma.worker.upsert({ where: { name: info.name }, create: data, update: data });
    this.deps.logger.info({ workerId: worker.id, name: worker.name, cpus: worker.cpus, memoryMb: worker.memoryMb }, "Worker registered");
    return { worker: view(worker), token };
  }

  /** The control plane's own worker: registered at startup, no secret, heartbeats in-process. */
  async registerBuiltIn(info: WorkerInfo): Promise<WorkerView> {
    const data = { ...info, builtIn: true, acceptsJobs: true, tokenHash: null, lastHeartbeatAt: new Date() };
    const existing = await this.deps.prisma.worker.findUnique({ where: { name: info.name } });
    const worker = await this.deps.prisma.worker.upsert({
      where: { name: info.name },
      create: data,
      // A drain survives a restart; being offline doesn't.
      update: { ...data, status: existing?.status === "DRAINING" ? "DRAINING" : "ONLINE" },
    });
    return view(worker);
  }

  /** Authenticates a worker by its secret. */
  async authenticate(workerId: string, token: string | null): Promise<Worker> {
    const worker = token?.startsWith(TOKEN_PREFIX)
      ? await this.deps.prisma.worker.findUnique({ where: { tokenHash: hash(token) } })
      : null;
    if (!worker || worker.id !== workerId) throw new UnauthenticatedError("Invalid worker token.");
    return worker;
  }

  /** A sign of life. Brings an OFFLINE worker back ONLINE; a DRAINING one stays DRAINING. */
  async heartbeat(workerId: string, report: { runningJobs: number; cpus?: number; memoryMb?: number }): Promise<WorkerView> {
    const current = await this.deps.prisma.worker.findUnique({ where: { id: workerId } });
    if (!current) throw new NotFoundError(`Worker not found: ${workerId}`);
    const worker = await this.deps.prisma.worker.update({
      where: { id: workerId },
      data: {
        lastHeartbeatAt: new Date(),
        runningJobs: report.runningJobs,
        ...(report.cpus !== undefined && { cpus: report.cpus }),
        ...(report.memoryMb !== undefined && { memoryMb: report.memoryMb }),
        ...(current.status === "OFFLINE" && { status: "ONLINE" }),
      },
    });
    if (current.status === "OFFLINE") this.deps.logger.info({ workerId, name: worker.name }, "Worker back online");
    return view(worker);
  }

  /** A worker shutting down cleanly says so, instead of timing out. */
  async disconnect(workerId: string): Promise<void> {
    await this.deps.prisma.worker.update({ where: { id: workerId }, data: { status: "OFFLINE", runningJobs: 0 } });
    this.deps.logger.info({ workerId }, "Worker disconnected");
  }

  /** Marks workers that stopped heartbeating OFFLINE. Returns their ids. */
  async sweep(now = new Date()): Promise<string[]> {
    const stale = await this.deps.prisma.worker.findMany({
      where: { status: { in: ["ONLINE", "DRAINING"] }, lastHeartbeatAt: { lt: new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS) } },
      select: { id: true, name: true },
    });
    if (stale.length === 0) return [];
    await this.deps.prisma.worker.updateMany({ where: { id: { in: stale.map((w) => w.id) } }, data: { status: "OFFLINE" } });
    for (const worker of stale) this.deps.logger.warn({ workerId: worker.id, name: worker.name }, "Worker missed its heartbeats: OFFLINE");
    return stale.map((worker) => worker.id);
  }

  // ───────────── administration (SHIPYARD_ADMINS) ─────────────

  async list(login: string): Promise<WorkerView[]> {
    this.assertAdmin(login);
    const workers = await this.deps.prisma.worker.findMany({ orderBy: [{ builtIn: "desc" }, { name: "asc" }] });
    return workers.map(view);
  }

  /** No new work for it; what it runs keeps running. */
  async drain(login: string, workerId: string): Promise<WorkerView> {
    this.assertAdmin(login);
    return this.setStatus(workerId, "DRAINING");
  }

  async undrain(login: string, workerId: string): Promise<WorkerView> {
    this.assertAdmin(login);
    const worker = await this.deps.prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) throw new NotFoundError(`Worker not found: ${workerId}`);
    if (worker.status !== "DRAINING") return view(worker);
    return this.setStatus(workerId, "ONLINE");
  }

  isAdmin(login: string): boolean {
    return this.deps.admins.includes(login.toLowerCase());
  }

  private async setStatus(workerId: string, status: "ONLINE" | "DRAINING"): Promise<WorkerView> {
    const exists = await this.deps.prisma.worker.findUnique({ where: { id: workerId }, select: { id: true } });
    if (!exists) throw new NotFoundError(`Worker not found: ${workerId}`);
    const worker = await this.deps.prisma.worker.update({ where: { id: workerId }, data: { status } });
    this.deps.logger.info({ workerId, status }, "Worker status changed");
    return view(worker);
  }

  private assertAdmin(login: string): void {
    // Not 404: workers aren't a tenant's resource, and their existence isn't a secret from signed-in users.
    if (!this.isAdmin(login)) throw new ForbiddenError("Only platform administrators (SHIPYARD_ADMINS) manage workers.");
  }
}

function view({ tokenHash: _hash, ...worker }: Worker): WorkerView {
  return worker;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, so the join token can't be guessed byte by byte from response times. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
