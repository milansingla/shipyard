import type { RequestHandler } from "express";

import type { Logger } from "../lib/logger.js";

/** One structured log line per request, written when the response finishes. */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info(
        {
          method: req.method,
          // originalUrl, not path: routers rewrite req.path to be relative to their mount point.
          path: req.originalUrl.split("?")[0],
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs),
        },
        "request",
      );
    });
    next();
  };
}
