import { z } from "zod";

export const createProjectSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(2048),
  /** Omit to use the repository's default branch (resolved at creation time). */
  branch: z.string().trim().min(1).max(255).optional(),
  /** Display name. Defaults to the repository name. */
  name: z.string().trim().min(1).max(64).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
