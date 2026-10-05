import express, { Router } from "express";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { sendData } from "../../lib/http.js";
import { verifyGitHubSignature } from "./signature.js";
import type { WebhookService } from "./WebhookService.js";

/** GitHub caps payloads at 25 MB; pushes Shipyard cares about are far smaller. */
const MAX_PAYLOAD = "1mb";
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/;

/**
 * POST /api/webhooks/github — mounted BEFORE express.json(): the signature is
 * over the raw bytes, so this route parses the body itself after verifying it.
 * No session: GitHub authenticates with the HMAC signature instead.
 */
export function createWebhookRouter(webhooks: WebhookService | null, secret: string | null): Router {
  const router = Router();

  router.post("/webhooks/github", express.raw({ type: () => true, limit: MAX_PAYLOAD }), async (req, res) => {
    if (!webhooks || !secret) {
      throw new AppError(
        ErrorCode.WEBHOOKS_NOT_CONFIGURED,
        "Push deploys are not configured on this server. Set GITHUB_WEBHOOK_SECRET (see docs/github.md).",
        { statusCode: 503 },
      );
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Verify before reading anything else: an unsigned request gets no information back.
    if (!verifyGitHubSignature(secret, body, req.get("x-hub-signature-256"))) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, "Invalid webhook signature.", { statusCode: 401 });
    }
    if (!req.is("application/json")) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Set the webhook\'s content type to "application/json" in the GitHub repository settings.',
        { statusCode: 415 },
      );
    }

    const deliveryId = req.get("x-github-delivery") ?? "";
    const event = req.get("x-github-event") ?? "";
    if (!DELIVERY_ID.test(deliveryId) || !event) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing X-GitHub-Delivery or X-GitHub-Event header.", {
        statusCode: 400,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Webhook body is not valid JSON.", { statusCode: 400 });
    }

    // 200 (not 202) even when deploys start in the background: GitHub only needs to know it was received.
    sendData(res, await webhooks.handle(deliveryId, event, payload));
  });

  return router;
}
