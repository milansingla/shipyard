// Response shapes of the Shipyard API (apps/api). Kept by hand for V2: the API
// is small and these mirror the Prisma models / route responses directly.
// Dates arrive as ISO strings.

export type DeploymentStatus =
  | "QUEUED"
  | "CLONING"
  | "DETECTING"
  | "BUILDING"
  | "STARTING"
  | "HEALTH_CHECKING"
  | "HEALTHY"
  | "ROUTING"
  | "RUNNING"
  | "FAILED"
  | "STOPPING"
  | "STOPPED";

export interface User {
  id: string;
  githubId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export type DeploymentTrigger = "MANUAL" | "PUSH";

export interface Deployment {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  /** What started it: someone deploying, or a GitHub push. */
  trigger: DeploymentTrigger;
  branch: string;
  commitSha: string | null;
  imageName: string | null;
  containerName: string | null;
  containerId: string | null;
  containerPort: number | null;
  hostPort: number | null;
  deploymentUrl: string | null;
  errorMessage: string | null;
  /** The stage a FAILED deployment failed in (null for deployments from before V3). */
  failedStage: DeploymentStatus | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  repositoryUrl: string;
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  /** "/" accepts any status below 500; another path must answer 2xx/3xx. */
  healthCheckPath: string;
  /** null = the app's own port. */
  healthCheckPort: number | null;
  /** null = the server default. */
  healthCheckTimeoutSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithLatestDeployment extends Project {
  latestDeployment: Deployment | null;
}

/** When a variable is available: to the running app, to the build, or both. */
export type EnvironmentTarget = "RUNTIME" | "BUILD" | "BOTH";

export interface EnvironmentVariable {
  key: string;
  /** null for secrets: the API never sends a secret's value back. */
  value: string | null;
  secret: boolean;
  target: EnvironmentTarget;
  updatedAt: string;
}

export interface DeploymentLogs {
  type: "build" | "runtime";
  content: string;
  message?: string;
}

export interface GitHubRepository {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string;
  repositoryUrl: string;
  deployable: boolean;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
