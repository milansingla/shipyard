import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { AuditService } from "./AuditService.js";

const querySchema = z.object({
  projectId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Page backwards: entries with an id lower than this. */
  before: z.coerce.number().int().positive().optional(),
});

export function createAuditRouter(audit: AuditService): Router {
  const router = Router();
  router.get("/audit-logs", async (req, res) => {
    const user = requireUser(req);
    sendData(res, await audit.list(user.id, parseInput(querySchema, req.query, "query")));
  });
  return router;
}
