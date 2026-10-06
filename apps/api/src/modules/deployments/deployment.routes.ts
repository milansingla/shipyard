import { Router } from "express";
import { z } from "zod";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { sendData } from "../../lib/http.js";
import type { Logger } from "../../lib/logger.js";
import { openEventStream } from "../../lib/sse.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { DeploymentService } from "./DeploymentService.js";

const logsQuerySchema = z.object({
  type: z.enum(["build", "runtime"]).default("build"),
  tail: z.coerce.number().int().min(1).max(5000).default(200),
});

/** Each open stream holds a connection and a follower; cap them per user. */
const MAX_STREAMS_PER_USER = 10;

class StreamLimiter {
  private readonly open = new Map<string, number>();

  acquire(userId: string): () => void {
    const count = this.open.get(userId) ?? 0;
    if (count >= MAX_STREAMS_PER_USER) {
      throw new AppError(ErrorCode.RATE_LIMITED, "Too many open log streams. Close some tabs and try again.", {
        statusCode: 429,
      });
    }
    this.open.set(userId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(userId) ?? 1) - 1;
      if (left === 0) this.open.delete(userId);
      else this.open.set(userId, left);
    };
  }
}

export function createDeploymentRouter(deployments: DeploymentService, logger?: Logger): Router {
  const router = Router();
  const streams = new StreamLimiter();

  router.get("/deployments/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.get(id, user.id));
  });

  /** Brings back the previous working deployment. Responds once traffic has moved. */
  /** Whether it waits for an ADMIN's approval (organization policy), and who decided. */
  router.get("/deployments/:id/approval", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.approvalOf(id, user.id));
  });

  router.post("/deployments/:id/approve", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.decide(id, user.id, true));
  });

  router.post("/deployments/:id/reject", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.decide(id, user.id, false));
  });

  /** Only while still waiting in the queue. */
  router.post("/deployments/:id/cancel", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.cancel(id, user.id));
  });

  router.post("/deployments/:id/rollback", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.rollback(id, user.id));
  });

  /** The deployment's history: creation, every status change, who caused it. Oldest first. */
  router.get("/deployments/:id/events", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.listEvents(id, user.id));
  });

  /**
   * Live logs as Server-Sent Events: `log` events ({ text }) as output appears,
   * then `end` ({ message? }) when there is nothing more. Each connection
   * starts with a snapshot, so a reconnecting client replaces what it shows.
   */
  router.get("/deployments/:id/logs/stream", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    const { type, tail } = parseInput(logsQuerySchema, req.query, "query");
    await deployments.get(id, user.id); // 404 before opening a stream
    const release = streams.acquire(user.id);

    const stream = openEventStream(req, res);
    try {
      const { message } = await deployments.followLogs(id, user.id, type, tail, (text) => stream.send("log", { text }), stream.signal);
      stream.send("end", message ? { message } : {});
    } catch (error) {
      stream.send("end", { message: error instanceof AppError ? error.message : "Log stream failed." });
      logger?.warn({ err: error, deploymentId: id }, "Log stream failed");
    } finally {
      release();
      stream.close();
    }
  });

  /** ?type=build (default): stored build log. ?type=runtime&tail=200: live container output. */
  router.get("/deployments/:id/logs", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    const { type, tail } = parseInput(logsQuerySchema, req.query, "query");
    sendData(res, await deployments.getLogs(id, user.id, type, tail));
  });

  router.post("/deployments/:id/stop", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.stop(id, user.id));
  });

  /** Synchronous: responds after the restarted container passes its health check. */
  router.post("/deployments/:id/restart", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.restart(id, user.id));
  });

  /** 202 Accepted: creates and starts a NEW deployment of the same project. */
  router.post("/deployments/:id/redeploy", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.redeploy(id, user.id), 202);
  });

  return router;
}
