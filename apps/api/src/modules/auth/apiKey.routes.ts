import { Router } from "express";
import { z } from "zod";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { ApiKeyService } from "./ApiKeyService.js";

const createApiKeySchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  /** Omit for a key that doesn't expire. */
  expiresInDays: z.int().min(1).max(365).optional(),
});

export function createApiKeyRouter(apiKeys: ApiKeyService): Router {
  const router = Router();

  router.get("/api-keys", async (req, res) => {
    sendData(res, await apiKeys.list(requireUser(req).id));
  });

  /** 201 with { key, token }. The token is shown this once. */
  router.post("/api-keys", async (req, res) => {
    const user = requireUser(req);
    // A leaked key must not be able to mint more keys: that needs a signed-in browser.
    if (req.authMethod !== "session") {
      throw new AppError(ErrorCode.FORBIDDEN, "API keys can only be created from the dashboard.", { statusCode: 403 });
    }
    const input = parseInput(createApiKeySchema, req.body, "API key");
    sendData(res, await apiKeys.create(user.id, input), 201);
  });

  router.delete("/api-keys/:id", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "API key id");
    await apiKeys.revoke(user.id, id);
    res.status(204).end();
  });

  return router;
}
