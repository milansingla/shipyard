import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { DomainService } from "./DomainService.js";

const addDomainSchema = z.strictObject({ hostname: z.string().trim().min(1).max(253) });
const domainParamsSchema = z.object({ id: z.uuid(), hostname: z.string().min(1).max(253) });

export function createDomainRouter(domains: DomainService): Router {
  const router = Router();

  router.get("/projects/:id/domains", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    sendData(res, await domains.list(id, user.id));
  });

  /** Routed to the live deployment immediately. Point the hostname's DNS at this server. */
  router.post("/projects/:id/domains", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "project id");
    const { hostname } = parseInput(addDomainSchema, req.body, "domain");
    sendData(res, await domains.add(id, user.id, hostname), 201);
  });

  router.delete("/projects/:id/domains/:hostname", async (req, res) => {
    const user = requireUser(req);
    const { id, hostname } = parseInput(domainParamsSchema, req.params, "domain");
    await domains.remove(id, user.id, hostname);
    res.status(204).end();
  });

  return router;
}
