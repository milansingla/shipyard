import { Router } from "express";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import { z } from "zod";

import { createDatabaseSchema, createServiceSchema, createVolumeSchema, updateServiceSchema } from "./service.schemas.js";
import type { ServiceService } from "./ServiceService.js";
import type { VolumeService } from "./VolumeService.js";

/** Deleting data is never implied: it must be asked for explicitly. */
const deleteDataSchema = z.object({ deleteData: z.enum(["true", "false"]).default("false") });

export function createServiceRouter(services: ServiceService, volumes: VolumeService): Router {
  const router = Router();

  router.get("/projects/:id/services", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await services.list(id, user.id));
  });

  router.post("/projects/:id/services", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    if ((req.body as { type?: unknown } | undefined)?.type === "POSTGRES") {
      sendData(res, await services.createDatabase(id, user.id, parseInput(createDatabaseSchema, req.body, "database")), 201);
      return;
    }
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
    const { deleteData } = parseInput(deleteDataSchema, req.query, "query");
    await services.delete(id, user.id, { deleteData: deleteData === "true" });
    res.status(204).end();
  });

  router.get("/services/:id/volumes", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "service id");
    sendData(res, await volumes.list(id, user.id));
  });

  /** Mounted from the next deployment on. */
  router.post("/services/:id/volumes", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "service id");
    sendData(res, await volumes.create(id, user.id, parseInput(createVolumeSchema, req.body, "volume")), 201);
  });

  /** Detaches the volume; its data stays on the server (see docs/services.md). */
  router.delete("/volumes/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "volume id");
    sendData(res, await volumes.detach(id, user.id));
  });

  /** 202: deploys only this service. */
  router.post("/services/:id/deploy", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "service id");
    sendData(res, await services.deploy(id, user.id), 202);
  });

  return router;
}
