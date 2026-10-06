import { z } from "zod";

import { healthCheckPathSchema } from "../projects/project.schemas.js";
import { MAX_REPLICAS } from "../../services/docker/naming.js";
import { RESERVED_PREFIX } from "../environments/environmentRules.js";
import { DEFAULT_POSTGRES_VERSION, POSTGRES_VERSIONS } from "./postgres.js";

/** A DNS label (its name on the project network), short enough to prefix a project's hostname. */
export const serviceNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/, "must be 1–20 lowercase letters, digits or -, starting with a letter")
  .refine((name) => !name.includes("--"), "must not contain --")
  .refine((name) => !RESERVED_PREFIX.test(name), "must not start with dev or pr-<number>: environments use those addresses");

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
  /** Identical containers, load-balanced. Applied on the next deploy. */
  replicas: z.int().min(1).max(MAX_REPLICAS).optional(),
};

export const createServiceSchema = z
  .strictObject({ name: serviceNameSchema, type: z.enum(["WEB", "WORKER"]).default("WEB"), ...settings })
  .refine((input) => input.type === "WEB" || input.public !== true, { message: "Workers can't be public.", path: ["public"] });

/** A PostgreSQL service: a name and a major version. Shipyard sets everything else. */
export const createDatabaseSchema = z.strictObject({
  name: serviceNameSchema,
  type: z.literal("POSTGRES"),
  version: z.union(POSTGRES_VERSIONS.map((v) => z.literal(v))).default(DEFAULT_POSTGRES_VERSION),
  cpuLimit: settings.cpuLimit,
  memoryLimitMb: settings.memoryLimitMb,
});

/** What can change on a database: its resources. Not its version (the data directory is version-specific). */
export const updateDatabaseSchema = z
  .strictObject({ cpuLimit: settings.cpuLimit, memoryLimitMb: settings.memoryLimitMb })
  .refine((input) => Object.keys(input).length > 0, "Nothing to update.");

export const updateServiceSchema = z
  .strictObject(settings)
  .refine((input) => Object.keys(input).length > 0, "Nothing to update.");

/** Lowercase label, unique within the service. */
export const volumeNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$/, "must be 1–30 lowercase letters, digits or -, starting with a letter");

/** An absolute path in the container; not the root or a system directory. */
export const mountPathSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "must be an absolute path like /app/uploads")
  // "." too: /app/./x and /app/x would be two volumes on one directory.
  .refine((p) => !p.split("/").some((part) => part === "." || part === ".."), "must not contain . or .. segments")
  .refine((p) => !/^\/(proc|sys|dev|etc|bin|sbin|lib|lib64|usr|boot|run)(\/|$)/.test(p), "must not be a system directory");

export const createVolumeSchema = z.strictObject({ name: volumeNameSchema, mountPath: mountPathSchema });

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
