import type { ErrorRequestHandler, RequestHandler } from "express";

import { AppError, ErrorCode } from "../lib/errors.js";
import type { ErrorBody } from "../lib/http.js";
import type { Logger } from "../lib/logger.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ErrorBody = {
    error: { code: ErrorCode.NOT_FOUND, message: `Route not found: ${req.method} ${req.path}` },
  };
  res.status(404).json(body);
};

/**
 * Converts every thrown error into the standard `{ error: { code, message } }` shape.
 * Expected failures (AppError) keep their message; unexpected ones are logged
 * with their stack and, in production, replaced by a generic message.
 */
export function createErrorHandler(logger: Logger, exposeInternalErrors: boolean): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) logger.error({ err: error, path: req.path }, error.message);
      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined && { details: error.details }),
        },
      };
      res.status(error.statusCode).json(body);
      return;
    }

    // Malformed (400) or oversized (413) body, from express.json() / express.raw().
    const bodyError = bodyParserStatus(error);
    if (bodyError !== null) {
      const message = bodyError === 413 ? "Request body is too large." : "Malformed request body.";
      const body: ErrorBody = { error: { code: ErrorCode.VALIDATION_ERROR, message } };
      res.status(bodyError).json(body);
      return;
    }

    logger.error({ err: error, path: req.path }, "Unhandled error");
    const body: ErrorBody = {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: exposeInternalErrors && error instanceof Error ? error.message : "Internal server error.",
      },
    };
    res.status(500).json(body);
  };
}

function bodyParserStatus(error: unknown): 400 | 413 | null {
  const candidate = error as { type?: string; status?: number } | null;
  if (typeof candidate?.type !== "string") return null;
  return candidate.status === 400 || candidate.status === 413 ? candidate.status : null;
}
