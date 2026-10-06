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
  /** null = production; otherwise a development environment or a pull request's preview. */
  environmentId: string | null;
  /** Identical containers this deployment runs; logs show the first. */
  replicas: number;
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
  /** Build a preview for each pull request into the project's branch. */
  previewDeployments: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ServiceType = "WEB" | "WORKER" | "POSTGRES";

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
  /** Identical containers per deployment, load-balanced (1–10). */
  replicas: number;
  /** The prebuilt image a database runs, e.g. postgres:17-alpine; null for services built from the repository. */
  image: string | null;
  /** Owns the project's own address. */
  primary: boolean;
  /** Declared in the repository's shipyard.yaml, or in the dashboard. */
  managedBy: "DASHBOARD" | "CONFIG_FILE";
  /** Settings changed in the dashboard, which shipyard.yaml no longer overwrites. */
  overrides: string[];
  /** First hostname label when public; null for workers and private services. */
  routeName: string | null;
  latestDeployment: Deployment | null;
  volumes: Volume[];
}

/** Persistent storage mounted into every deployment of a service. */
export interface Volume {
  id: string;
  serviceId: string;
  name: string;
  mountPath: string;
  /** The Docker volume holding the data on the server. */
  dockerName: string;
  createdAt: string;
}

export interface ProjectWithLatestDeployment extends Project {
  latestDeployment: Deployment | null;
}

/** When a variable is available: to the running app, to the build, or both. */
export type EnvironmentTarget = "RUNTIME" | "BUILD" | "BOTH";

/** Which environments a variable applies to. */
export type VariableEnvironment = "ALL" | "PRODUCTION" | "PREVIEW" | "DEVELOPMENT";

export interface EnvironmentVariable {
  key: string;
  environment: VariableEnvironment;
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
  /** Empty = everything you may do; otherwise read, deploy or write. */
  scopes: string[];
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

export type CronRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "SKIPPED";

/** One run of a cron job. `output` (the last 64 KB) only comes with a single run. */
export interface CronRun {
  id: string;
  cronJobId: string;
  status: CronRunStatus;
  trigger: "SCHEDULE" | "MANUAL";
  deploymentId: string | null;
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  output?: string;
}

/** A command run on a schedule (UTC) in a service's live image. */
export interface CronJob {
  id: string;
  projectId: string;
  serviceId: string;
  serviceName: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  timeoutSeconds: number;
  /** null while paused. */
  nextRunAt: string | null;
  managedBy: "DASHBOARD" | "CONFIG_FILE";
  lastRun: CronRun | null;
}

/** An environment besides production (which is the project itself). */
export interface ProjectEnvironment {
  id: string;
  projectId: string;
  type: "DEVELOPMENT" | "PREVIEW";
  /** "dev" or "pr-<number>": the first part of its hostnames. */
  name: string;
  branch: string;
  pullRequest: number | null;
  title: string | null;
  status: "ACTIVE" | "CLOSED";
  createdAt: string;
  closedAt: string | null;
  /** The newest deployment of each of its services. */
  deployments: Deployment[];
}

export interface ServiceMetrics {
  serviceId: string;
  name: string;
  deploymentId: string | null;
  status: DeploymentStatus | null;
  replicas: number;
  running: number;
  cpuPercent: number | null;
  memoryMb: number | null;
  memoryLimitMb: number | null;
  restartCount: number | null;
  uptimeSeconds: number | null;
  /** The last hour. */
  series: Array<{ at: string; cpuPercent: number; memoryMb: number }>;
}

export interface ProjectMetrics {
  services: ServiceMetrics[];
  deployments: {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
    averageDeployMs: number | null;
    averageBuildMs: number | null;
  };
}

export interface AlertItem {
  id: string;
  organizationId: string | null;
  projectId: string | null;
  kind: "DEPLOYMENT_FAILED" | "APP_DOWN" | "WORKER_OFFLINE" | "HIGH_CPU" | "HIGH_MEMORY" | "DISK_PRESSURE";
  severity: "WARNING" | "CRITICAL";
  title: string;
  message: string;
  status: "OPEN" | "RESOLVED";
  openedAt: string;
  resolvedAt: string | null;
}

/** Where alerts are sent. The URL is never returned, only its host. */
export interface NotificationChannel {
  id: string;
  organizationId: string | null;
  name: string;
  type: "WEBHOOK" | "SLACK";
  host: string;
  enabled: boolean;
  lastError: string | null;
  lastSentAt: string | null;
}

/** A team inside an organization, and the projects it is granted a role on. */
export interface OrgTeam {
  id: string;
  name: string;
  members: Array<{ id: string; login: string }>;
  grants: Array<{ projectId: string; projectName: string; role: OrgRole }>;
}

export interface ServiceAccount {
  id: string;
  login: string;
  name: string;
  role: OrgRole;
  keys: ApiKey[];
}

export interface Policy {
  organizationId: string;
  maxMemoryMb: number | null;
  maxCpu: number | null;
  maxReplicas: number | null;
  requireHealthCheckPath: boolean;
  allowedDomainSuffixes: string[];
  requireApproval: boolean;
}

export interface Approval {
  status: "NOT_REQUIRED" | "AWAITING" | "APPROVED" | "REJECTED";
  decidedBy: string | null;
  decidedAt: string | null;
}

/** A free public https://<random>.trycloudflare.com address for the live app (Cloudflare quick tunnel). */
export interface PublicLinkInfo {
  /** Public links work on this server (routing through Traefik is on). */
  available: boolean;
  enabled: boolean;
  /** absent = off; starting = Cloudflare is assigning the address; live = it works; failed = see detail. */
  state: "absent" | "starting" | "live" | "failed";
  url: string | null;
  detail: string | null;
}
