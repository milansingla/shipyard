import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import type { DeploymentService } from "./DeploymentService.js";

const logsQuerySchema = z.object({
  type: z.enum(["build", "runtime"]).default("build"),
  tail: z.coerce.number().int().min(1).max(5000).default(200),
});

export function createDeploymentRouter(deployments: DeploymentService): Router {
  const router = Router();

  router.get("/deployments/:id", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.get(id));
  });

  /** ?type=build (default): stored build log. ?type=runtime&tail=200: live container output. */
  router.get("/deployments/:id/logs", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    const { type, tail } = parseInput(logsQuerySchema, req.query, "query");
    sendData(res, await deployments.getLogs(id, type, tail));
  });

  router.post("/deployments/:id/stop", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.stop(id));
  });

  /** Synchronous: responds after the restarted container passes its health check. */
  router.post("/deployments/:id/restart", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.restart(id));
  });

  /** 202 Accepted: creates and starts a NEW deployment of the same project. */
  router.post("/deployments/:id/redeploy", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await deployments.redeploy(id), 202);
  });

  return router;
}
