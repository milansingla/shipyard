import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { ProjectEnvironments } from "./ProjectEnvironments.js";

const developmentSchema = z.strictObject({ type: z.literal("DEVELOPMENT"), branch: z.string().min(1).max(255) });
const updateSchema = z.strictObject({ branch: z.string().min(1).max(255) });

export function createProjectEnvironmentsRouter(environments: ProjectEnvironments): Router {
  const router = Router();

  router.get("/projects/:id/environments", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await environments.list(id, user.id));
  });

  /** The development environment. Previews are created by pull requests. */
  router.post("/projects/:id/environments", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    const { branch } = parseInput(developmentSchema, req.body, "environment");
    sendData(res, await environments.createDevelopment(id, user.id, { branch }), 201);
  });

  router.patch("/environments/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "environment id");
    sendData(res, await environments.update(id, user.id, parseInput(updateSchema, req.body, "environment")));
  });

  router.post("/environments/:id/deploy", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "environment id");
    sendData(res, await environments.deploy(id, user.id), 202);
  });

  /** Takes it down: containers and images are removed, its history stays. */
  router.post("/environments/:id/close", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "environment id");
    sendData(res, await environments.close(id, user.id));
  });

  return router;
}
