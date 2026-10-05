import { Router } from "express";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import { envKeyParamsSchema, setEnvVarSchema } from "./environment.schemas.js";
import type { EnvironmentService } from "./EnvironmentService.js";

export function createEnvironmentRouter(environment: EnvironmentService): Router {
  const router = Router();

  router.get("/projects/:id/env", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await environment.list(id, user.id));
  });

  /** Create or replace. Takes effect on the next deployment. */
  router.put("/projects/:id/env/:key", async (req, res) => {
    const user = requireUser(req);
    const { id, key } = parseInput(envKeyParamsSchema, req.params, "variable name");
    const input = parseInput(setEnvVarSchema, req.body, "environment variable");
    sendData(res, await environment.set(id, user.id, key, input));
  });

  router.delete("/projects/:id/env/:key", async (req, res) => {
    const user = requireUser(req);
    const { id, key } = parseInput(envKeyParamsSchema, req.params, "variable name");
    await environment.remove(id, user.id, key);
    res.status(204).end();
  });

  return router;
}
