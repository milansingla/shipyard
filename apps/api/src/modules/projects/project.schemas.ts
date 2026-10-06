import { z } from "zod";

export const createProjectSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(2048),
  /** Omit to use the repository's default branch (resolved at creation time). */
  branch: z.string().trim().min(1).max(255).optional(),
  /** Display name. Defaults to the repository name. */
  name: z.string().trim().min(1).max(64).optional(),
  /** The team to create it in (needs DEVELOPER there). Default: the user's personal organization. */
  organizationId: z.uuid().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * A path on the app, never a URL: one leading "/", then no "/" (which would make
 * "//host" a different server), whitespace, control characters, backslashes or fragments.
 */
export const healthCheckPathSchema = z
  .string()
  .trim()
  .max(512)
  .regex(/^\/(?!\/)[^\s\\#\p{Cc}]*$/u, "must be a path starting with a single /, without spaces, backslashes or #");

/** Project settings. Applied to the next deployment. */
export const updateProjectSchema = z
  .strictObject({
    healthCheckPath: healthCheckPathSchema.optional(),
    /** null = the app's own port. */
    healthCheckPort: z.int().min(1).max(65535).nullable().optional(),
    /** null = the server default (SHIPYARD_HEALTHCHECK_TIMEOUT_MS). */
    healthCheckTimeoutSeconds: z.int().min(5).max(900).nullable().optional(),
    /** CPUs, in steps of 0.01 (e.g. 0.5); null = no limit. */
    cpuLimit: z
      .number()
      .min(0.1)
      .max(64)
      .multipleOf(0.01, "at most 2 decimals")
      .nullable()
      .optional(),
    /** MB; null = no limit. Below 64 MB most runtimes can't even start. */
    memoryLimitMb: z.int().min(64).max(262_144).nullable().optional(),
    restartPolicy: z.enum(["NO", "ON_FAILURE", "UNLESS_STOPPED"]).optional(),
    /** Build a preview for each pull request into the project's branch (from branches of the repository, never forks). */
    previewDeployments: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "Nothing to update.");

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
