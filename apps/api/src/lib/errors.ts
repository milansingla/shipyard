/**
 * Stable, machine-readable error codes. API clients branch on these,
 * so they must never be renamed casually.
 */
export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  PROJECT_ALREADY_EXISTS: "PROJECT_ALREADY_EXISTS",
  DEPLOYMENT_IN_PROGRESS: "DEPLOYMENT_IN_PROGRESS",
  CONFIG_INVALID: "CONFIG_INVALID",
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  COMMAND_FAILED: "COMMAND_FAILED",
  GIT_CLONE_FAILED: "GIT_CLONE_FAILED",
  GIT_REF_NOT_FOUND: "GIT_REF_NOT_FOUND",
  DOCKERFILE_NOT_FOUND: "DOCKERFILE_NOT_FOUND",
  DOCKER_BUILD_FAILED: "DOCKER_BUILD_FAILED",
  DOCKER_UNAVAILABLE: "DOCKER_UNAVAILABLE",
  CONTAINER_START_FAILED: "CONTAINER_START_FAILED",
  HEALTH_CHECK_FAILED: "HEALTH_CHECK_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

interface AppErrorOptions {
  statusCode?: number;
  details?: unknown;
  cause?: unknown;
}

/**
 * An expected, classified failure. Anything that is NOT an AppError reaching
 * the HTTP error handler is treated as a bug and reported as a generic 500.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.VALIDATION_ERROR, message, { statusCode: 400, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(ErrorCode.NOT_FOUND, message, { statusCode: 404 });
  }
}

/** The request is valid but conflicts with the current state (HTTP 409). */
export class ConflictError extends AppError {
  constructor(code: ErrorCode, message: string) {
    super(code, message, { statusCode: 409 });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
