import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { PolicyService } from "./PolicyService.js";

const policySchema = z
  .strictObject({
    maxMemoryMb: z.int().min(64).max(262_144).nullable(),
    maxCpu: z.number().min(0.1).max(64).nullable(),
    maxReplicas: z.int().min(1).max(10).nullable(),
    requireHealthCheckPath: z.boolean(),
    allowedDomainSuffixes: z
      .array(z.string().trim().toLowerCase().regex(/^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "must be a domain like example.com"))
      .max(20),
    requireApproval: z.boolean(),
  })
  .partial()
  .refine((input) => Object.keys(input).length > 0, "Nothing to update.");

export function createPolicyRouter(policies: PolicyService): Router {
  const router = Router();

  router.get("/organizations/:id/policy", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await policies.get(id, requireUser(req).id));
  });

  router.patch("/organizations/:id/policy", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await policies.update(id, requireUser(req).id, parseInput(policySchema, req.body, "policy")));
  });

  return router;
}
