import type { RepositoryRef } from "../git/repositoryUrl.js";
import type { DeploymentStatus } from "./status.js";

/** What to deploy. Built by the caller from already-validated input. */
export interface DeploymentJob {
  id: string;
  repository: RepositoryRef;
  /** null = the repository's default branch. */
  branch: string | null;
  /** Human-readable base for image/container names (project slug or repo name). */
  name: string;
  /** Extra Docker labels, e.g. the owning project's id. */
  labels?: Record<string, string>;
  /** Decrypted variables: `runtime` goes into the container, `build` becomes build args. */
  env?: { runtime: Record<string, string>; build: Record<string, string> };
}

/**
 * Everything the engine learns while running a job. Field names match the
 * Prisma `Deployment` model so a persisting observer can store it as-is.
 */
export interface DeploymentState {
  id: string;
  status: DeploymentStatus;
  branch: string | null;
  commitSha: string | null;
  imageName: string;
  containerName: string;
  containerId: string | null;
  containerPort: number | null;
  hostPort: number | null;
  deploymentUrl: string | null;
  errorMessage: string | null;
  /** The stage the run was in when it failed (set only when FAILED). */
  failedStage: DeploymentStatus | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** build = `docker build` output, runtime = app stdout/stderr, system = Shipyard's own messages. */
export type DeploymentLogSource = "system" | "build" | "runtime";

/**
 * Hooks for whoever started the deployment (the CLI prints; the API persists).
 * `onStatusChange` is awaited, so a persisting observer's writes happen in order
 * and a failed write fails the deployment instead of being silently lost.
 */
export interface DeploymentObserver {
  onStatusChange?(state: Readonly<DeploymentState>, previous: DeploymentStatus): void | Promise<void>;
  onLog?(source: DeploymentLogSource, text: string): void;
}

export interface ContainerActionResult {
  containerName: string;
  status: DeploymentStatus;
  hostPort: number | null;
  deploymentUrl: string | null;
}
