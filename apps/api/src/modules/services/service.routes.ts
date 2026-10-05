import { Router } from "express";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import { createServiceSchema, updateServiceSchema } from "./service.schemas.js";
import type { ServiceService } from "./ServiceService.js";

export function createServiceRouter(services: ServiceService): Router {
  const router = Router();

  router.get("/projects/:id/services", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await services.list(id, user.id));
  });

  router.post("/projects/:id/services", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    const input = parseInput(createServiceSchema, req.body, "service");
    sendData(res, await services.create(id, user.id, input), 201);
  });

  router.patch("/services/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "service id");
    const input = parseInput(updateServiceSchema, req.body, "service");
    sendData(res, await services.update(id, user.id, input));
  });

  router.delete("/services/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "service id");
    await services.delete(id, user.id);
    res.status(204).end();
  });

  /** 202: deploys only this service. */
  router.post("/services/:id/deploy", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "service id");
    sendData(res, await services.deploy(id, user.id), 202);
  });

  return router;
}
