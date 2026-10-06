import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../../db/prisma.js";
import { AppError, ErrorCode, NotFoundError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";

/** What a worker reports when a call fails. */
export interface CallError {
  code: string;
  message: string;
  /** A failed deployment's final state (run). */
  deployment?: unknown;
}

interface Waiter {
  workerId: string;
  method: string;
  /** Kept in memory only: a deploy's arguments include decrypted secrets. */
  args: unknown;
  onEvent?: (event: unknown) => Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cancelled: boolean;
  taken: boolean;
}

export interface CallOptions {
  /** Streaming progress from the worker (status changes, log lines…); its return value is the worker's reply. */
  onEvent?: (event: unknown) => Promise<unknown>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
/** How long a worker's poll waits for a call before answering "nothing". */
export const LONG_POLL_MS = 25_000;

/**
 * Engine operations the control plane asks workers to perform. A call waits
 * in memory until its worker long-polls for it (next()), then the worker
 * streams events and completes it. The `worker_calls` row records method,
 * status and timing, never the arguments: a deploy's arguments carry the
 * app's decrypted secrets. Calls live in this process: if the control plane
 * restarts, they fail (and the deploy queue's leases take over).
 */
export class WorkerCalls {
  private readonly waiters = new Map<string, Waiter>();
  private readonly pollers = new Map<string, Set<() => void>>();

  constructor(private readonly deps: { prisma: PrismaClient; logger: Logger }) {}

  async call<T>(workerId: string, method: string, args: unknown, options: CallOptions = {}): Promise<T> {
    const id = randomUUID();
    await this.deps.prisma.workerCall.create({ data: { id, workerId, method, args: summarize(method, args) } });
    const result = new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        void this.settle(id, { error: { code: ErrorCode.WORKER_UNAVAILABLE, message: `Worker didn't finish ${method} within ${Math.round(timeoutMs / 1000)}s.` } });
      }, timeoutMs);
      timer.unref();
      this.waiters.set(id, { workerId, method, args, onEvent: options.onEvent, resolve: resolve as (r: unknown) => void, reject, timer, cancelled: false, taken: false });
    });
    this.wake(workerId);
    return result;
  }

  /** Asks the worker to stop a streaming call (followLogs); its next event is answered "cancelled". */
  cancel(callId: string): void {
    const waiter = this.waiters.get(callId);
    if (waiter) waiter.cancelled = true;
  }

  /** The id of the newest call in flight for `method` (lets followLogs be cancelled). */
  latest(workerId: string, method: string): string | null {
    let found: string | null = null;
    for (const [id, waiter] of this.waiters) if (waiter.workerId === workerId && waiter.method === method) found = id;
    return found;
  }

  /** A worker's long poll: the oldest call waiting for it, or null after `waitMs`. */
  async next(workerId: string, waitMs = LONG_POLL_MS): Promise<{ id: string; method: string; args: unknown } | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const call = this.take(workerId);
      if (call) {
        await this.deps.prisma.workerCall.update({ where: { id: call.id }, data: { status: "TAKEN", takenAt: new Date() } }).catch(() => {});
        return call;
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const wakeUp = () => {
          clearTimeout(timer);
          this.pollers.get(workerId)?.delete(wakeUp);
          resolve();
        };
        const timer = setTimeout(wakeUp, left);
        if (!this.pollers.has(workerId)) this.pollers.set(workerId, new Set());
        this.pollers.get(workerId)!.add(wakeUp);
      });
    }
  }

  /** Progress from the worker; the reply goes back to it ({cancelled: true} stops a stream). */
  async event(workerId: string, callId: string, event: unknown): Promise<unknown> {
    const waiter = this.waiterOf(workerId, callId);
    if (waiter.cancelled) return { cancelled: true };
    return { reply: (await waiter.onEvent?.(event)) ?? null };
  }

  async complete(workerId: string, callId: string, outcome: { result?: unknown; error?: CallError }): Promise<void> {
    this.waiterOf(workerId, callId);
    await this.settle(callId, outcome);
  }

  /** The worker is gone: everything waiting on it fails as WORKER_LOST. */
  async failWorker(workerId: string, reason: string): Promise<number> {
    const ids = [...this.waiters].filter(([, waiter]) => waiter.workerId === workerId).map(([id]) => id);
    for (const id of ids) await this.settle(id, { error: { code: ErrorCode.WORKER_LOST, message: `WORKER_LOST: ${reason}` } });
    return ids.length;
  }

  /** Calls left over by a previous control plane process can't be answered any more. */
  async failOrphans(): Promise<number> {
    const { count } = await this.deps.prisma.workerCall.updateMany({
      where: { status: { in: ["PENDING", "TAKEN"] } },
      data: { status: "FAILED", finishedAt: new Date(), error: { code: "INTERRUPTED", message: "The control plane restarted." } },
    });
    return count;
  }

  private take(workerId: string): { id: string; method: string; args: unknown } | null {
    for (const [id, waiter] of this.waiters) {
      if (waiter.workerId === workerId && !waiter.taken) {
        waiter.taken = true;
        return { id, method: waiter.method, args: waiter.args };
      }
    }
    return null;
  }

  private waiterOf(workerId: string, callId: string): Waiter {
    const waiter = this.waiters.get(callId);
    // Another worker's call, or one already finished: nothing to say about it.
    if (!waiter || waiter.workerId !== workerId) throw new NotFoundError(`Call not found: ${callId}`);
    return waiter;
  }

  private async settle(callId: string, outcome: { result?: unknown; error?: CallError }): Promise<void> {
    const waiter = this.waiters.get(callId);
    if (!waiter) return;
    this.waiters.delete(callId);
    clearTimeout(waiter.timer);
    await this.deps.prisma.workerCall
      .update({
        where: { id: callId },
        data: outcome.error
          ? { status: "FAILED", finishedAt: new Date(), error: { code: outcome.error.code, message: outcome.error.message } }
          : { status: "DONE", finishedAt: new Date() },
      })
      .catch(() => {});
    if (outcome.error) waiter.reject(new RemoteCallError(outcome.error));
    else waiter.resolve(outcome.result ?? null);
  }

  private wake(workerId: string): void {
    for (const wakeUp of [...(this.pollers.get(workerId) ?? [])]) wakeUp();
  }
}

/** A failed worker call, carrying the worker's error code (and a failed deployment's state). */
export class RemoteCallError extends AppError {
  constructor(readonly detail: CallError) {
    super(detail.code as ErrorCode, detail.message, { statusCode: detail.code === ErrorCode.NOT_FOUND ? 404 : 422 });
  }
}

/** What the database keeps about a call's arguments: ids, never values (no secrets at rest). */
function summarize(method: string, args: unknown): Record<string, string> {
  const a = (args ?? {}) as Record<string, unknown>;
  const job = a.job as Record<string, unknown> | undefined;
  return {
    method,
    ...(typeof job?.id === "string" && { deploymentId: job.id }),
    ...(typeof a.containerReference === "string" && { container: a.containerReference }),
  };
}
