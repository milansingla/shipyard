import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { AiService } from "./AiService.js";

const askSchema = z.strictObject({
  question: z.string().trim().min(3).max(2_000),
});

/** The AI assistant: advice and proposals only; every change still goes through the normal endpoints. */
export function createAiRouter(ai: AiService): Router {
  const router = Router();

  router.post("/ai/projects/:id/analysis", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await ai.analyzeRepository(id, requireUser(req).id));
  });

  router.post("/ai/projects/:id/dockerfile", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await ai.suggestDockerfile(id, requireUser(req).id));
  });

  router.post("/ai/deployments/:id/diagnosis", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "deployment id");
    sendData(res, await ai.diagnoseDeployment(id, requireUser(req).id));
  });

  router.post("/ai/alerts/:id/summary", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "alert id");
    sendData(res, await ai.summarizeIncident(id, requireUser(req).id));
  });

  router.post("/ai/ask", async (req, res) => {
    const { question } = parseInput(askSchema, req.body, "question");
    sendData(res, await ai.ask(requireUser(req).id, question));
  });

  return router;
}
