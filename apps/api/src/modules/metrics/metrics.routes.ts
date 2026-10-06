import { Router } from "express";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { MetricsService } from "./MetricsService.js";

export function createMetricsRouter(metrics: MetricsService): Router {
  const router = Router();

  /** CPU, memory, restarts and uptime per service (now, and the last hour), and deployment stats. */
  router.get("/projects/:id/metrics", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await metrics.forProject(id, user.id));
  });

  return router;
}
