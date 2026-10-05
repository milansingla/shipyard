import { z } from "zod";

import { healthCheckPathSchema } from "../projects/project.schemas.js";

/** A DNS label (its name on the project network), short enough to prefix a project's hostname. */
export const serviceNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/, "must be 1–20 lowercase letters, digits or -, starting with a letter")
  .refine((name) => !name.includes("--"), "must not contain --");

/** A directory inside the repository: relative, no `..`, no leading or trailing /. */
export const sourceDirSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^(?:\.|[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/, "must be a relative directory like apps/web")
  .refine((dir) => !dir.split("/").includes(".."), "must stay inside the repository");

/** One line, run with `sh -c` in the container. */
const commandSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .regex(/^[^\n\r\0]+$/, "must be a single line");

const settings = {
  sourceDir: sourceDirSchema.optional(),
  buildCommand: commandSchema.nullable().optional(),
  startCommand: commandSchema.nullable().optional(),
  port: z.int().min(1).max(65535).nullable().optional(),
  public: z.boolean().optional(),
  healthCheckPath: healthCheckPathSchema.nullable().optional(),
  healthCheckPort: z.int().min(1).max(65535).nullable().optional(),
  healthCheckTimeoutSeconds: z.int().min(5).max(900).nullable().optional(),
  cpuLimit: z.number().min(0.1).max(64).multipleOf(0.01, "at most 2 decimals").nullable().optional(),
  memoryLimitMb: z.int().min(64).max(262_144).nullable().optional(),
};

export const createServiceSchema = z
  .strictObject({ name: serviceNameSchema, type: z.enum(["WEB", "WORKER"]).default("WEB"), ...settings })
  .refine((input) => input.type === "WEB" || input.public !== true, { message: "Workers can't be public.", path: ["public"] });

export const updateServiceSchema = z
  .strictObject(settings)
  .refine((input) => Object.keys(input).length > 0, "Nothing to update.");

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
