import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { AlertService } from "./AlertService.js";

const channelSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  type: z.enum(["WEBHOOK", "SLACK"]),
  url: z.string().trim().min(1).max(2_000),
});
const listSchema = z.object({
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function createAlertRouter(alerts: AlertService): Router {
  const router = Router();

  router.get("/alerts", async (req, res) => {
    sendData(res, await alerts.list(requireUser(req), parseInput(listSchema, req.query, "query")));
  });

  router.get("/organizations/:id/notification-channels", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await alerts.listChannels(id, requireUser(req)));
  });

  router.post("/organizations/:id/notification-channels", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await alerts.createChannel(id, requireUser(req), parseInput(channelSchema, req.body, "channel")), 201);
  });

  /** The platform's own channel (worker alerts): SHIPYARD_ADMINS. */
  router.get("/notification-channels", async (req, res) => {
    sendData(res, await alerts.listChannels(null, requireUser(req)));
  });

  router.post("/notification-channels", async (req, res) => {
    sendData(res, await alerts.createChannel(null, requireUser(req), parseInput(channelSchema, req.body, "channel")), 201);
  });

  router.delete("/notification-channels/:id", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "channel id");
    await alerts.deleteChannel(id, requireUser(req));
    res.status(204).end();
  });

  router.post("/notification-channels/:id/test", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "channel id");
    sendData(res, await alerts.testChannel(id, requireUser(req)));
  });

  return router;
}
