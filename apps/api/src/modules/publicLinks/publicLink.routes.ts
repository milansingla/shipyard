import { Router } from "express";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { PublicLinkService } from "./PublicLinkService.js";

export function createPublicLinkRouter(links: PublicLinkService): Router {
  const router = Router();

  router.get("/projects/:id/public-link", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await links.get(id, user.id));
  });

  /** Starts (or restarts, with a new address) the project's public link. */
  router.post("/projects/:id/public-link", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await links.enable(id, user.id), 201);
  });

  router.delete("/projects/:id/public-link", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    await links.disable(id, user.id);
    res.status(204).end();
  });

  return router;
}
