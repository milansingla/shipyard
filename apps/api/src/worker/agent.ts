import { AsyncLocalStorage } from "node:async_hooks";

import { AppError, ErrorCode } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { EngineApi, WorkerEvent } from "../modules/workers/RemoteEngine.js";
import { DeploymentFailedError } from "../services/deployment/DeploymentEngine.js";
import type { DeploymentJob } from "../services/deployment/types.js";
import type { OneOffContainerOptions } from "../services/docker/DockerService.js";
import type { RouteTarget, Router } from "../services/routing/Router.js";

/** How the control plane addresses apps (sent when the worker registers). */
export type Routing = { mode: "traefik"; domain: string; httpPort: number; httpsPort: number | null } | { mode: "direct" } | null;

export interface AgentOptions {
  controlPlaneUrl: string;
  joinToken: string;
  info: { name: string; hostname: string; cpus: number; memoryMb: number; version: string; address?: string };
  /** This machine's engine, given the router the agent provides (it routes through the control plane). */
  createEngine: (router: Router) => EngineApi;
  logger: Logger;
  signal?: AbortSignal;
  /** Calls run at once. */
  concurrency?: number;
}

interface Call {
  id: string;
  method: string;
  args: Record<string, unknown>;
}

/**
 * A worker: registers with the control plane, heartbeats, and performs the
 * engine calls it is sent (deploy, stop, restart, logs, …) on this machine's
 * Docker, streaming progress back. Traffic is moved by the control plane:
 * when the engine wants a route, the agent sends it as an event.
 * Resolves when `signal` aborts (after saying goodbye).
 */
export async function runWorkerAgent(options: AgentOptions): Promise<void> {
  const { controlPlaneUrl, logger, signal } = options;
  const base = controlPlaneUrl.replace(/\/+$/, "");
  const post = async (path: string, token: string, body?: unknown, timeoutMs = 30_000, cancellable = true): Promise<Response> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal && cancellable ? [signal] : [])]),
    });
    if (response.status >= 400) {
      const text = await response.text().catch(() => "");
      throw new AppError(ErrorCode.WORKER_UNAVAILABLE, `Control plane answered ${response.status} to ${path}: ${text.slice(0, 300)}`);
    }
    return response;
  };

  const registered = (await (await post("/api/workers/register", options.joinToken, { ...options.info, acceptsJobs: true })).json()) as {
    data: { worker: { id: string }; token: string; heartbeatIntervalMs: number; routing: Routing };
  };
  const { worker, token, heartbeatIntervalMs, routing } = registered.data;
  logger.info({ workerId: worker.id, name: options.info.name }, "Registered with the control plane");

  const current = new AsyncLocalStorage<{ callId: string }>();
  const event = async (callId: string, payload: WorkerEvent): Promise<{ cancelled?: boolean }> =>
    (await (await post(`/api/workers/${worker.id}/calls/${callId}/events`, token, { event: payload })).json()) as { cancelled?: boolean };

  const router: Router = {
    network: null, // Traefik reaches this machine at its address, not over a Docker network
    urlFor(name, hostPort) {
      if (routing?.mode === "traefik") {
        return routing.httpsPort !== null
          ? `https://${name}.${routing.domain}${routing.httpsPort === 443 ? "" : `:${routing.httpsPort}`}`
          : `http://${name}.${routing.domain}${routing.httpPort === 80 ? "" : `:${routing.httpPort}`}`;
      }
      return `http://${options.info.address ?? "localhost"}:${hostPort}`;
    },
    async activate(target: RouteTarget) {
      const call = current.getStore();
      if (!call) throw new AppError(ErrorCode.ROUTING_FAILED, "A route was requested outside a call.");
      await event(call.callId, { type: "route", target });
    },
    async deactivate() {},
    async sync() {},
  };
  const engine = options.createEngine(router);

  let inflight = 0;
  const heartbeat = setInterval(() => {
    post(`/api/workers/${worker.id}/heartbeat`, token, { runningJobs: inflight }).catch((error: unknown) =>
      logger.warn({ err: error }, "Heartbeat failed"),
    );
  }, heartbeatIntervalMs);
  heartbeat.unref();

  const perform = async (call: Call): Promise<unknown> => {
    const args = call.args;
    switch (call.method) {
      case "run": {
        // Log lines are sent in batches, flushed before each status change so the order holds.
        let buffered: Array<{ source: "system" | "build" | "runtime"; text: string }> = [];
        const flush = async () => {
          const lines = buffered;
          buffered = [];
          for (const line of mergeLines(lines)) await event(call.id, { type: "log", ...line });
        };
        const ticker = setInterval(() => void flush().catch(() => {}), 300);
        try {
          return await engine.run(args.job as DeploymentJob, {
            onLog: (source, text) => void buffered.push({ source, text }),
            onStatusChange: async (state, previous) => {
              await flush();
              await event(call.id, { type: "status", state: { ...state }, previous });
            },
          });
        } finally {
          clearInterval(ticker);
          await flush().catch(() => {});
        }
      }
      case "restart":
        return engine.restart(String(args.containerReference), args.route as { name: string; aliases?: string[] } | null, async (status) => {
          await event(call.id, { type: "stage", status });
        });
      case "followLogs": {
        const controller = new AbortController();
        await engine.followLogs(
          String(args.containerReference),
          Number(args.tail),
          (chunk) => {
            void event(call.id, { type: "chunk", chunk })
              .then((reply) => reply.cancelled && controller.abort())
              .catch(() => controller.abort());
          },
          controller.signal,
        );
        return null;
      }
      case "stop":
        return engine.stop(String(args.containerReference));
      case "getLogs":
        return engine.getLogs(String(args.containerReference), args.tail === undefined ? undefined : Number(args.tail));
      case "inspect":
        return engine.inspect(String(args.containerReference));
      case "destroy":
        return engine.destroy(args.artifacts as Parameters<EngineApi["destroy"]>[0]);
      case "ensureRoutable":
        return engine.ensureRoutable(String(args.containerReference));
      case "removeNetwork":
        return engine.removeNetwork(String(args.name));
      case "removeVolumes":
        return engine.removeVolumes(args.names as string[]);
      case "runToCompletion":
        return engine.runToCompletion(args.options as OneOffContainerOptions);
      default:
        throw new AppError(ErrorCode.VALIDATION_ERROR, `Unknown call: ${call.method}`);
    }
  };

  const handle = async (call: Call) => {
    inflight += 1;
    try {
      const result = await current.run({ callId: call.id }, () => perform(call));
      await post(`/api/workers/${worker.id}/calls/${call.id}/complete`, token, { result: result ?? null }, 30_000, false);
    } catch (error) {
      const deployment = error instanceof DeploymentFailedError ? error.deployment : undefined;
      const code = error instanceof AppError ? error.code : ErrorCode.INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : String(error);
      await post(`/api/workers/${worker.id}/calls/${call.id}/complete`, token, { error: { code, message, ...(deployment && { deployment }) } }, 30_000, false).catch(
        (reportError: unknown) => logger.error({ err: reportError, callId: call.id }, "Could not report a call's failure"),
      );
    } finally {
      inflight -= 1;
    }
  };

  const running = new Set<Promise<void>>();
  try {
    while (!signal?.aborted) {
      if (running.size >= (options.concurrency ?? 8)) {
        await Promise.race(running);
        continue;
      }
      let call: Call | null = null;
      try {
        const response = await post(`/api/workers/${worker.id}/calls/next`, token, {}, 35_000);
        if (response.status === 200) call = ((await response.json()) as { data: Call }).data;
      } catch (error) {
        if (signal?.aborted) break;
        logger.warn({ err: error }, "Polling the control plane failed; retrying");
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      if (!call) continue;
      const task = handle(call).finally(() => running.delete(task));
      running.add(task);
    }
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled([...running]);
    await post(`/api/workers/${worker.id}/disconnect`, token, {}, 5_000, false).catch(() => {});
    logger.info({ workerId: worker.id }, "Disconnected from the control plane");
  }
}

/** Consecutive lines from the same source, joined: fewer round trips. */
function mergeLines(lines: Array<{ source: "system" | "build" | "runtime"; text: string }>) {
  const merged: typeof lines = [];
  for (const line of lines) {
    const last = merged.at(-1);
    if (last && last.source === line.source && last.text.length < 16_384) last.text += line.text;
    else merged.push({ ...line });
  }
  return merged;
}
