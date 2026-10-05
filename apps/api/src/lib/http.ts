import type { Response } from "express";

import type { ErrorCode } from "./errors.js";

/** Every successful API response: `{ "data": ... }` */
export interface DataBody<T> {
  data: T;
}

/** Every failed API response: `{ "error": { "code": ..., "message": ... } }` */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export function sendData<T>(res: Response, data: T, statusCode = 200): void {
  const body: DataBody<T> = { data };
  res.status(statusCode).json(body);
}
