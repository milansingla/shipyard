import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import { createProjectSchema } from "./project.schemas.js";
import type { ProjectService } from "./ProjectService.js";

const listDeploymentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function createProjectRouter(projects: ProjectService, deployments: DeploymentService): Router {
  const router = Router();

  router.post("/projects", async (req, res) => {
    const input = parseInput(createProjectSchema, req.body, "project");
    sendData(res, await projects.create(input), 201);
  });

  router.get("/projects", async (_req, res) => {
    sendData(res, await projects.list());
  });

  router.get("/projects/:id", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await projects.get(id));
  });

  router.delete("/projects/:id", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    await projects.delete(id);
    res.status(204).end();
  });

  /** 202 Accepted: the deployment runs in the background. Poll GET /api/deployments/:id. */
  router.post("/projects/:id/deploy", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await deployments.deploy(id), 202);
  });

  router.get("/projects/:id/deployments", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    const { limit } = parseInput(listDeploymentsQuerySchema, req.query, "query");
    sendData(res, await deployments.listForProject(id, limit));
  });

  return router;
}
