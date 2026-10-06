import { z } from "zod";

/** POSIX-style names: what shells, Node's process.env and Docker all accept. */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Set by Shipyard itself: the port the app must listen on. */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set(["PORT"]);
export const MAX_ENV_VALUE_LENGTH = 32 * 1024;
export const MAX_ENV_VARS_PER_PROJECT = 100;

export const ENV_TARGETS = ["RUNTIME", "BUILD", "BOTH"] as const;
/** ALL = every environment, except that a secret set for ALL never reaches a preview. */
export const VARIABLE_ENVIRONMENTS = ["ALL", "PRODUCTION", "PREVIEW", "DEVELOPMENT"] as const;
export type VariableEnvironmentName = (typeof VARIABLE_ENVIRONMENTS)[number];
/** Where a deployment runs. */
export type DeploymentEnvironmentName = Exclude<VariableEnvironmentName, "ALL">;

export const envKeySchema = z
  .string()
  .regex(ENV_KEY_PATTERN, "must start with a letter or _, and contain only letters, digits and _ (max 128)")
  .refine((key) => !RESERVED_ENV_KEYS.has(key), "is set by Shipyard and can't be overridden");

export const envKeyParamsSchema = z.object({ id: z.uuid(), key: envKeySchema });

export const setEnvVarSchema = z
  .object({
    value: z
      .string()
      .max(MAX_ENV_VALUE_LENGTH, `must be at most ${MAX_ENV_VALUE_LENGTH} characters`)
      // Docker passes variables as "KEY=value" C strings; a NUL byte would cut the value short.
      .refine((value) => !value.includes("\0"), "must not contain NUL characters"),
    /** Secret values are never shown again after saving. */
    secret: z.boolean().default(false),
    target: z.enum(ENV_TARGETS).default("RUNTIME"),
  })
  .refine((input) => !input.secret || input.target === "RUNTIME", {
    // `docker build --build-arg` values are recorded in the image's history.
    message: "Secrets are only available at runtime: build arguments are visible in the image's history.",
    path: ["target"],
  });

export type SetEnvVarInput = z.infer<typeof setEnvVarSchema>;
