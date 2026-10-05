import type { RequestHandler } from "express";

import { AppError, ErrorCode } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests, on top of SameSite=Lax.
 *
 * Browsers attach `Origin` (and `Sec-Fetch-Site`) to cross-site POST/DELETE
 * requests; a page on another site cannot forge or remove them. Any
 * state-changing request whose Origin isn't one of ours is refused.
 * Requests without these headers (curl, CLI) are not browser-driven CSRF and pass.
 */
export function originCheck(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map((url) => new URL(url).origin));

  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get("origin");
    const crossSite = req.get("sec-fetch-site") === "cross-site";
    if ((origin !== undefined && !allowed.has(origin)) || (origin === undefined && crossSite)) {
      throw new AppError(ErrorCode.FORBIDDEN, "Cross-site request refused.", { statusCode: 403 });
    }
    next();
  };
}
