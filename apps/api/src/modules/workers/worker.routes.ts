import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import { type WorkerCalls } from "./WorkerCalls.js";
import { HEARTBEAT_INTERVAL_MS, type WorkerRegistry } from "./WorkerRegistry.js";

const callParamsSchema = z.object({ id: z.uuid(), callId: z.uuid() });

const nameSchema = z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "must be a lowercase DNS label, up to 40 characters");
const capacity = {
  cpus: z.number().positive().max(1024),
  memoryMb: z.int().positive().max(16 * 1024 * 1024),
};
/** A hostname or IPv4 address Traefik and the control plane can reach. */
const addressSchema = z
  .string()
  .trim()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3})$/, "must be a hostname or IPv4 address");
const registerSchema = z.strictObject({
  name: nameSchema,
  hostname: z.string().trim().min(1).max(253),
  version: z.string().trim().min(1).max(40),
  address: addressSchema.optional(),
  /** An agent that runs deploys (shipyard worker); false = registered for monitoring only. */
  acceptsJobs: z.boolean().default(true),
  ...capacity,
});
const completeSchema = z.union([
  z.strictObject({ result: z.unknown() }),
  z.strictObject({ error: z.strictObject({ code: z.string().max(64), message: z.string().max(10_000), deployment: z.unknown().optional() }) }),
]);
const heartbeatSchema = z.strictObject({
  runningJobs: z.int().min(0).max(10_000),
  diskFreePercent: z.number().min(0).max(100).optional(),
  cpus: capacity.cpus.optional(),
  memoryMb: capacity.memoryMb.optional(),
});

function bearer(header: string | undefined): string | null {
  return /^Bearer (.+)$/i.exec(header ?? "")?.[1]?.trim() ?? null;
}

/**
 * Worker endpoints, authenticated by worker secrets (not user sessions):
 * register (with the join token), heartbeat and disconnect (with the worker's
 * own secret). Mounted before user authentication.
 */
export function createWorkerAgentRouter(
  registry: WorkerRegistry,
  calls: WorkerCalls | null,
  /** How apps are addressed, so a worker's engine builds the same URLs as the control plane. */
  routing: unknown = null,
): Router {
  const router = Router();

  router.post("/workers/register", async (req, res) => {
    const info = parseInput(registerSchema, req.body, "worker");
    const { worker, token } = await registry.register(bearer(req.get("authorization")), info);
    sendData(res, { worker, token, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, routing }, 201);
  });

  if (calls) {
    /** Long poll: the next call for this worker, or 204 after ~25 s. */
    router.post("/workers/:id/calls/next", async (req, res) => {
      const { id } = parseInput(idParamsSchema, req.params, "worker id");
      await registry.authenticate(id, bearer(req.get("authorization")));
      const call = await calls.next(id);
      if (!call) {
        res.status(204).end();
        return;
      }
      sendData(res, call);
    });

    router.post("/workers/:id/calls/:callId/events", async (req, res) => {
      const { id, callId } = parseInput(callParamsSchema, req.params, "call");
      await registry.authenticate(id, bearer(req.get("authorization")));
      sendData(res, await calls.event(id, callId, (req.body as { event?: unknown }).event));
    });

    router.post("/workers/:id/calls/:callId/complete", async (req, res) => {
      const { id, callId } = parseInput(callParamsSchema, req.params, "call");
      await registry.authenticate(id, bearer(req.get("authorization")));
      await calls.complete(id, callId, parseInput(completeSchema, req.body, "outcome"));
      res.status(204).end();
    });
  }

  router.post("/workers/:id/heartbeat", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "worker id");
    await registry.authenticate(id, bearer(req.get("authorization")));
    sendData(res, await registry.heartbeat(id, parseInput(heartbeatSchema, req.body, "heartbeat")));
  });

  router.post("/workers/:id/disconnect", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "worker id");
    await registry.authenticate(id, bearer(req.get("authorization")));
    await registry.disconnect(id);
    res.status(204).end();
  });

  return router;
}

/** Platform administration of workers (SHIPYARD_ADMINS), for signed-in users. */
export function createWorkerAdminRouter(registry: WorkerRegistry): Router {
  const router = Router();

  router.get("/workers", async (req, res) => {
    sendData(res, await registry.list(requireUser(req).login));
  });

  router.post("/workers/:id/drain", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "worker id");
    sendData(res, await registry.drain(user.login, id));
  });

  router.post("/workers/:id/undrain", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "worker id");
    sendData(res, await registry.undrain(user.login, id));
  });

  return router;
}
