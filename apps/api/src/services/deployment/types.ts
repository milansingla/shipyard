import type { DeploymentStatus } from "./status.js";

/**
 * Everything Shipyard knows about one deployment. Field names deliberately
 * match the planned Prisma `Deployment` model so Milestone 2 can persist it as-is.
 */
export interface DeploymentRecord {
  id: string;
  repositoryUrl: string;
  repositoryOwner: string;
  repositoryName: string;
  /** null = the repository's default branch. */
  branch: string | null;
  commitSha: string | null;
  status: DeploymentStatus;
  imageName: string;
  containerId: string | null;
  containerName: string;
  containerPort: number | null;
  hostPort: number | null;
  deploymentUrl: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface DeployRequest {
  repositoryUrl: string;
  branch?: string;
}

/** build = `docker build` output, runtime = app stdout/stderr, system = Shipyard's own messages. */
export type DeploymentLogSource = "system" | "build" | "runtime";

/**
 * Hooks for whoever started the deployment (CLI today; database + API in
 * Milestone 2). Called synchronously — observers must not throw.
 */
export interface DeploymentObserver {
  onStatusChange?(record: Readonly<DeploymentRecord>, previous: DeploymentStatus): void;
  onLog?(source: DeploymentLogSource, text: string): void;
}

export interface ContainerActionResult {
  containerName: string;
  status: DeploymentStatus;
  deploymentUrl: string | null;
}
