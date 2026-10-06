import type { Request, RequestHandler } from "express";

import { ForbiddenError } from "../lib/errors.js";

export const API_KEY_SCOPES = ["read", "deploy", "write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Operating a deployment, not changing configuration. */
const DEPLOY_ACTION = /\/(?:deploy|rollback|restart|stop|cancel|run)$/;

function isDeployAction(req: Request): boolean {
  return req.method === "POST" && DEPLOY_ACTION.test(req.path);
}

/**
 * What a scoped API key may do, on top of its owner's role:
 * read = GET only (and AI assistant questions, which change nothing); deploy = read, plus deploy/rollback/restart/stop/cancel
 * and running cron jobs; write (or no scopes, as before scopes existed) =
 * everything the owner may. A key never exceeds its owner's role.
 */
export function apiKeyScopes(): RequestHandler {
  return (req, _res, next) => {
    const scopes = req.user?.scopes;
    if (!scopes || scopes.length === 0 || scopes.includes("write")) return next();
    if (req.method === "GET" || req.method === "HEAD") return next();
    // The AI assistant only reads and advises: its proposals run through the normal endpoints.
    if (req.method === "POST" && req.path.startsWith("/ai/")) return next();
    if (scopes.includes("deploy") && isDeployAction(req)) return next();
    throw new ForbiddenError(
      `This API key is limited to ${scopes.join(" and ")}: ${scopes.includes("deploy") ? "reading and deploying" : "reading"} only.`,
    );
  };
}
