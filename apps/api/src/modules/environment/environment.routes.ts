import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import { envKeyParamsSchema, setEnvVarSchema } from "./environment.schemas.js";
import type { EnvironmentService } from "./EnvironmentService.js";

/** ?service=<id>: a variable for that one service; omitted: for every service of the project. */
const scopeQuerySchema = z.object({ service: z.uuid().optional() });

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
    const { service } = parseInput(scopeQuerySchema, req.query, "query");
    sendData(res, await environment.set(id, user.id, key, input, service ?? null));
  });

  router.delete("/projects/:id/env/:key", async (req, res) => {
    const user = requireUser(req);
    const { id, key } = parseInput(envKeyParamsSchema, req.params, "variable name");
    const { service } = parseInput(scopeQuerySchema, req.query, "query");
    await environment.remove(id, user.id, key, service ?? null);
    res.status(204).end();
  });

  return router;
}
