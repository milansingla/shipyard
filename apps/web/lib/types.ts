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
  | "STOPPED"
  | "ROLLING_BACK";

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
  serviceId: string;
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

export type RestartPolicy = "NO" | "ON_FAILURE" | "UNLESS_STOPPED";

/** Higher roles can do everything lower ones can. The API enforces them; the dashboard just hides what you can't do. */
export type OrgRole = "OWNER" | "ADMIN" | "DEVELOPER" | "VIEWER";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  personal: boolean;
  /** Your role in it. */
  role: OrgRole;
  members: number;
}

export interface Member {
  userId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  since: string;
}

export interface Project {
  id: string;
  organizationId: string;
  organization: { id: string; name: string; personal: boolean };
  /** Your role in the project's organization. */
  role: OrgRole;
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
  /** CPUs, e.g. 0.5; null = no limit. */
  cpuLimit: number | null;
  /** null = no limit. */
  memoryLimitMb: number | null;
  restartPolicy: RestartPolicy;
  createdAt: string;
  updatedAt: string;
}

export type ServiceType = "WEB" | "WORKER";

export interface Service {
  id: string;
  projectId: string;
  name: string;
  type: ServiceType;
  sourceDir: string;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  public: boolean;
  /** Owns the project's own address. */
  primary: boolean;
  /** Declared in the repository's shipyard.yaml, or in the dashboard. */
  managedBy: "DASHBOARD" | "CONFIG_FILE";
  /** Settings changed in the dashboard, which shipyard.yaml no longer overwrites. */
  overrides: string[];
  /** First hostname label when public; null for workers and private services. */
  routeName: string | null;
  latestDeployment: Deployment | null;
}

export interface ProjectWithLatestDeployment extends Project {
  latestDeployment: Deployment | null;
}

/** When a variable is available: to the running app, to the build, or both. */
export type EnvironmentTarget = "RUNTIME" | "BUILD" | "BOTH";

export interface EnvironmentVariable {
  key: string;
  /** null = every service; otherwise the one service it applies to (and overrides the shared value for). */
  serviceId: string | null;
  /** null for secrets: the API never sends a secret's value back. */
  value: string | null;
  secret: boolean;
  target: EnvironmentTarget;
  updatedAt: string;
}

export interface DeploymentEvent {
  id: number;
  type: "CREATED" | "STATUS_CHANGED" | "ROLLBACK";
  fromStatus: DeploymentStatus | null;
  toStatus: DeploymentStatus | null;
  /** Login of the person who caused it; null when Shipyard acted on its own. */
  actor: string | null;
  message: string | null;
  /** ROLLBACK: the deployment rolled back to / from. */
  relatedDeploymentId: string | null;
  createdAt: string;
}

export interface ProjectDomain {
  hostname: string;
  serviceId: string | null;
  url: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  /** First characters of the token, to tell keys apart. The token itself is never shown again. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AuditEntry {
  id: number;
  action: string;
  /** Login of who did it; null = Shipyard itself. */
  actor: string | null;
  projectId: string | null;
  projectName: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
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
