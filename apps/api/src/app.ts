import express, { type Express } from "express";

import type { Logger } from "./lib/logger.js";
import { createErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { authenticate, requireUser } from "./middleware/authenticate.js";
import { originCheck } from "./middleware/originCheck.js";
import { DEFAULT_RATE_LIMITS, type RateLimits, isDeploy, isWrite, rateLimit } from "./middleware/rateLimit.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createOrganizationRouter } from "./modules/access/organization.routes.js";
import type { OrganizationService } from "./modules/access/OrganizationService.js";
import { createAuditRouter } from "./modules/audit/audit.routes.js";
import type { AuditService } from "./modules/audit/AuditService.js";
import { createApiKeyRouter } from "./modules/auth/apiKey.routes.js";
import type { ApiKeyService } from "./modules/auth/ApiKeyService.js";
import type { AuthService } from "./modules/auth/AuthService.js";
import { createDeploymentRouter } from "./modules/deployments/deployment.routes.js";
import type { DeploymentService } from "./modules/deployments/DeploymentService.js";
import { createDomainRouter } from "./modules/domains/domain.routes.js";
import type { DomainService } from "./modules/domains/DomainService.js";
import { createEnvironmentRouter } from "./modules/environment/environment.routes.js";
import type { EnvironmentService } from "./modules/environment/EnvironmentService.js";
import { createGitHubRouter } from "./modules/github/github.routes.js";
import { createProjectRouter } from "./modules/projects/project.routes.js";
import { createServiceRouter } from "./modules/services/service.routes.js";
import { createCronRouter } from "./modules/cron/cron.routes.js";
import type { CronService } from "./modules/cron/CronService.js";
import { createProjectEnvironmentsRouter } from "./modules/environments/environment.routes.js";
import type { ProjectEnvironments } from "./modules/environments/ProjectEnvironments.js";
import { createWorkerAdminRouter, createWorkerAgentRouter } from "./modules/workers/worker.routes.js";
import type { WorkerCalls } from "./modules/workers/WorkerCalls.js";
import { apiKeyScopes } from "./middleware/apiKeyScopes.js";
import { createTeamRouter } from "./modules/access/team.routes.js";
import { createAiRouter } from "./modules/ai/ai.routes.js";
import type { AiService } from "./modules/ai/AiService.js";
import { createPolicyRouter } from "./modules/policies/policy.routes.js";
import type { PolicyService } from "./modules/policies/PolicyService.js";
import type { TeamService } from "./modules/access/TeamService.js";
import type { ServiceAccountService } from "./modules/access/ServiceAccountService.js";
import { createMetricsRouter } from "./modules/metrics/metrics.routes.js";
import { createAlertRouter } from "./modules/alerts/alert.routes.js";
import type { AlertService } from "./modules/alerts/AlertService.js";
import type { MetricsService } from "./modules/metrics/MetricsService.js";
import type { WorkerRegistry } from "./modules/workers/WorkerRegistry.js";
import type { ServiceService } from "./modules/services/ServiceService.js";
import type { VolumeService } from "./modules/services/VolumeService.js";
import { createWebhookRouter } from "./modules/webhooks/webhook.routes.js";
import type { WebhookService } from "./modules/webhooks/WebhookService.js";
import type { ProjectService } from "./modules/projects/ProjectService.js";
import { createHealthRouter } from "./routes/health.js";
import type { DockerService } from "./services/docker/DockerService.js";
import type { GitHubClient } from "./services/github/GitHubClient.js";

export interface AppAuth {
  service: AuthService;
  github: GitHubClient;
  sessionCookie: string;
  secureCookies: boolean;
  /** Where the browser goes after signing in. */
  appUrl: string;
  apiKeys: ApiKeyService;
}

export interface AppDeps {
  docker: Pick<DockerService, "ping">;
  /** Optional so the app can be tested without a database. */
  projects?: ProjectService;
  deployments?: DeploymentService;
  /** Project environment variables; needs SHIPYARD_SECRET_KEY. */
  environment?: EnvironmentService | null;
  domains?: DomainService;
  audit?: AuditService;
  organizations?: OrganizationService;
  services?: ServiceService;
  cron?: CronService;
  environments?: ProjectEnvironments;
  workers?: WorkerRegistry;
  metrics?: MetricsService;
  alerts?: AlertService;
  teams?: TeamService;
  policies?: PolicyService;
  ai?: AiService;
  serviceAccounts?: ServiceAccountService;
  /** Engine calls to remote workers; null = remote workers can't run deploys. */
  workerCalls?: WorkerCalls | null;
  /** Told to workers when they register: how app URLs look. */
  workerRouting?: unknown;
  volumes?: VolumeService;
  /** null/omitted = GitHub sign-in not configured: protected routes answer 503. */
  auth?: AppAuth | null;
  /** GitHub push webhooks; null/omitted = not configured (503). */
  webhooks?: { service: WebhookService; secret: string } | null;
  /** Origins allowed to make state-changing browser requests (the API's and the dashboard's). */
  allowedOrigins?: readonly string[];
  logger: Logger;
  exposeInternalErrors: boolean;
  /** Defaults to DEFAULT_RATE_LIMITS. */
  rateLimits?: RateLimits;
  /** Express "trust proxy" (SHIPYARD_TRUST_PROXY); default: trust no X-Forwarded-For. */
  trustProxy?: string | false;
}

/** Builds the Express app without starting it — tests mount it on a random port. */
export function createApp(deps: AppDeps): Express {
  const { docker, projects, deployments, auth, logger, exposeInternalErrors } = deps;
  const app = express();

  app.disable("x-powered-by");
  // X-Forwarded-For is only believed from a proxy the operator names: the
  // dashboard's proxy passes a client-sent header through unchanged, so trusting
  // it would let anyone pick their own IP and dodge per-IP limits.
  app.set("trust proxy", deps.trustProxy ?? false);
  const limits = deps.rateLimits ?? DEFAULT_RATE_LIMITS;
  app.locals.authConfigured = Boolean(auth);
  // Versioned API: /api/v1/… is the stable path for clients (the CLI uses it);
  // /api/… keeps working for existing ones. Both reach the same handlers.
  app.use((req, res, next) => {
    if (req.url === "/api/v1" || req.url.startsWith("/api/v1/")) {
      req.url = `/api${req.url.slice("/api/v1".length)}`;
      res.setHeader("API-Version", "1");
    }
    next();
  });
  app.use(requestLogger(logger)); // first, so even requests rejected by the body parser are logged
  app.use(originCheck(deps.allowedOrigins ?? []));
  app.use("/api/auth", rateLimit("sign-in", limits.signIn, (req) => req.ip ?? "unknown"));
  app.use("/api/webhooks", rateLimit("webhooks", limits.webhooks, (req) => req.ip ?? "unknown"));
  // Before express.json(): webhook signatures are verified over the raw body.
  app.use("/api", createWebhookRouter(deps.webhooks?.service ?? null, deps.webhooks?.secret ?? null));
  app.use(express.json({ limit: "100kb" }));

  app.use("/api", createHealthRouter(docker));
  if (deps.workers) {
    // Workers authenticate with their own secrets, not user sessions.
    app.use("/api/workers/register", rateLimit("worker-register", limits.signIn, (req) => req.ip ?? "unknown"));
    app.use("/api", createWorkerAgentRouter(deps.workers, deps.workerCalls ?? null, deps.workerRouting ?? null));
  }
  if (auth) {
    app.use("/api", authenticate(auth.service, auth.sessionCookie));
    app.use("/api", apiKeyScopes());
    // Per signed-in user (anonymous requests are refused by requireUser anyway).
    const user = (req: Parameters<typeof isWrite>[0]) => req.user?.id ?? null;
    app.use("/api", rateLimit("deploys", limits.deploys, (req) => (isDeploy(req) ? user(req) : null)));
    app.use("/api", rateLimit("writes", limits.writes, (req) => (isWrite(req) && !isDeploy(req) ? user(req) : null)));
    app.use("/api", rateLimit("reads", limits.reads, (req) => (isWrite(req) ? null : user(req))));
    app.use("/api/ai", rateLimit("ai", limits.ai, user));
    app.use("/api", createAuthRouter(auth.service, auth));
    app.use("/api", createGitHubRouter(auth.service, auth.github));
    app.use("/api", createApiKeyRouter(auth.apiKeys));
  } else {
    // Answer sign-in routes with the setup instructions (503) rather than a bare 404,
    // so the dashboard can tell the operator what to configure.
    app.use(["/api/auth", "/api/github"], (req) => void requireUser(req));
  }
  if (projects && deployments) {
    app.use("/api", createProjectRouter(projects, deployments));
    app.use("/api", createDeploymentRouter(deployments, logger));
    if (deps.environment) app.use("/api", createEnvironmentRouter(deps.environment));
    if (deps.domains) app.use("/api", createDomainRouter(deps.domains));
    if (deps.audit) app.use("/api", createAuditRouter(deps.audit));
    if (deps.organizations) app.use("/api", createOrganizationRouter(deps.organizations));
    if (deps.services && deps.volumes) app.use("/api", createServiceRouter(deps.services, deps.volumes));
    if (deps.cron) app.use("/api", createCronRouter(deps.cron));
    if (deps.environments) app.use("/api", createProjectEnvironmentsRouter(deps.environments));
    if (deps.workers) app.use("/api", createWorkerAdminRouter(deps.workers));
    if (deps.metrics) app.use("/api", createMetricsRouter(deps.metrics));
    if (deps.alerts) app.use("/api", createAlertRouter(deps.alerts));
    if (deps.teams && deps.serviceAccounts) app.use("/api", createTeamRouter(deps.teams, deps.serviceAccounts));
    if (deps.policies) app.use("/api", createPolicyRouter(deps.policies));
    if (deps.ai) app.use("/api", createAiRouter(deps.ai));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger, exposeInternalErrors));

  return app;
}
