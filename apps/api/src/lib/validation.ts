import { z } from "zod";

import { ValidationError } from "./errors.js";

/**
 * Parses untrusted input (body, params, query) or throws a 400 with per-field
 * details. Handlers only ever see the typed, validated result.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown, what = "request"): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid ${what}.`, z.flattenError(result.error));
  }
  return result.data;
}

export const idParamsSchema = z.object({ id: z.uuid() });
