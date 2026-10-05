import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import { createCronJobSchema, updateCronJobSchema } from "./cron.schemas.js";
import type { CronService } from "./CronService.js";

const runsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

export function createCronRouter(cron: CronService): Router {
  const router = Router();

  router.get("/projects/:id/cron-jobs", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await cron.list(id, user.id));
  });

  router.post("/projects/:id/cron-jobs", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await cron.create(id, user.id, parseInput(createCronJobSchema, req.body, "cron job")), 201);
  });

  router.patch("/cron-jobs/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "cron job id");
    sendData(res, await cron.update(id, user.id, parseInput(updateCronJobSchema, req.body, "cron job")));
  });

  router.delete("/cron-jobs/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "cron job id");
    await cron.delete(id, user.id);
    res.status(204).end();
  });

  /** Runs it now, in the background. 202 with the run (or 202 SKIPPED, saying why). */
  router.post("/cron-jobs/:id/run", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "cron job id");
    sendData(res, await cron.runNow(id, user.id), 202);
  });

  router.get("/cron-jobs/:id/runs", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "cron job id");
    const { limit } = parseInput(runsQuerySchema, req.query, "query");
    sendData(res, await cron.runs(id, user.id, limit));
  });

  /** One run, with its output. */
  router.get("/cron-runs/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "cron run id");
    sendData(res, await cron.run(id, user.id));
  });

  return router;
}
