import Docker from "dockerode";

import type { AppConfig } from "./config/env.js";
import { type PrismaClient, createPrismaClient } from "./db/prisma.js";
import type { Logger } from "./lib/logger.js";
import type { AppAuth } from "./app.js";
import { SecretBox } from "./lib/secretBox.js";
import { sessionCookieName } from "./middleware/authenticate.js";
import { AccessService } from "./modules/access/AccessService.js";
import { OrganizationService } from "./modules/access/OrganizationService.js";
import { AuditService } from "./modules/audit/AuditService.js";
import { ApiKeyService } from "./modules/auth/ApiKeyService.js";
import { AuthService } from "./modules/auth/AuthService.js";
import { BuildLogStore } from "./modules/deployments/BuildLogStore.js";
import { DeploymentService } from "./modules/deployments/DeploymentService.js";
import { DomainService } from "./modules/domains/DomainService.js";
import { EnvironmentService } from "./modules/environment/EnvironmentService.js";
import { ProjectService } from "./modules/projects/ProjectService.js";
import { ConfigSync } from "./modules/services/ConfigSync.js";
import { ServiceService } from "./modules/services/ServiceService.js";
import { VolumeService } from "./modules/services/VolumeService.js";
import { WebhookService } from "./modules/webhooks/WebhookService.js";
import { DeploymentEngine } from "./services/deployment/DeploymentEngine.js";
import { HealthCheckService } from "./services/deployment/HealthCheckService.js";
import { DockerService } from "./services/docker/DockerService.js";
import { GitService } from "./services/git/GitService.js";
import { GitHubClient } from "./services/github/GitHubClient.js";
import { type ImageRegistry, LocalRegistry, RemoteRegistry } from "./services/registry/ImageRegistry.js";
import { DirectPortRouter, type Router } from "./services/routing/Router.js";
import { EDGE_NETWORK, TraefikRouter, createTraefikProbe } from "./services/routing/TraefikRouter.js";
import { WorkspaceService } from "./services/workspace/WorkspaceService.js";

export interface EngineServices {
  docker: DockerService;
  git: GitService;
  engine: DeploymentEngine;
  router: Router;
}

export interface ApiServices extends EngineServices {
  prisma: PrismaClient;
  projects: ProjectService;
  deployments: DeploymentService;
  /** null without SHIPYARD_SECRET_KEY (values are always stored encrypted). */
  environment: EnvironmentService | null;
  domains: DomainService;
  audit: AuditService;
  organizations: OrganizationService;
  services: ServiceService;
  volumes: VolumeService;
  /** null when GitHub sign-in is not configured. */
  auth: AppAuth | null;
  /** null when GITHUB_WEBHOOK_SECRET is not set. */
  webhooks: { service: WebhookService; secret: string } | null;
}

/**
 * Composition root: the ONE place where concrete services are constructed and
 * wired together. Everything else receives its dependencies as arguments,
 * which is what makes the services testable with fakes.
 */
export function createEngineServices(
  config: AppConfig,
  logger: Logger,
  router: Router = createRouter(config, logger),
): EngineServices {
  // Dockerode honours DOCKER_HOST; otherwise it uses the local Docker socket.
  const docker = new DockerService(
    new Docker(),
    { publishHost: config.publishHost, buildTimeoutMs: config.buildTimeoutMs },
    logger.child({ component: "docker" }),
  );
  const git = new GitService({ cloneTimeoutMs: config.gitCloneTimeoutMs }, logger.child({ component: "git" }));

  const engine = new DeploymentEngine({
    source: git,
    docker,
    healthCheck: new HealthCheckService(config.healthCheck),
    workspace: new WorkspaceService(config.workspaceDir),
    router,
    registry: createRegistry(config, docker),
    logger: logger.child({ component: "engine" }),
  });

  return { docker, git, engine, router };
}

/** A remote registry when SHIPYARD_REGISTRY is set; otherwise images stay in local Docker. */
function createRegistry(config: AppConfig, docker: DockerService): ImageRegistry {
  if (!config.registry) return new LocalRegistry();
  return new RemoteRegistry(config.registry.prefix, config.registry.credentials, docker);
}

/** Traefik when SHIPYARD_PUBLIC_DOMAIN is set; otherwise each deployment is reached on its own port. */
function createRouter(config: AppConfig, logger: Logger): Router {
  if (!config.routing) return new DirectPortRouter();
  const { domain, httpPort, routesDir, tls } = config.routing;
  return new TraefikRouter(
    // Traefik applies at most one configuration change every ~2s; 15s leaves room for a busy host.
    {
      network: EDGE_NETWORK,
      domain,
      httpPort,
      routesDir,
      cutoverTimeoutMs: 15_000,
      probeIntervalMs: 250,
      tls: tls && { httpsPort: tls.httpsPort },
    },
    createTraefikProbe(tls ? tls.httpsPort : httpPort, 3_000, Boolean(tls)),
    logger.child({ component: "router" }),
  );
}

/** Everything the HTTP API needs, including the database. */
export function createApiServices(config: AppConfig, databaseUrl: string, logger: Logger): ApiServices {
  const engineServices = createEngineServices(config, logger);
  const prisma = createPrismaClient(databaseUrl);
  const audit = new AuditService({ prisma, logger: logger.child({ component: "audit" }) });
  const access = new AccessService(prisma);
  const organizations = new OrganizationService({ prisma, access, audit, logger: logger.child({ component: "organizations" }) });
  const secretBox = config.auth.secretKey ? new SecretBox(config.auth.secretKey) : null;
  const environment = secretBox
    ? new EnvironmentService({ prisma, secretBox, access, audit, logger: logger.child({ component: "environment" }) })
    : null;

  const deployments = new DeploymentService({
    prisma,
    access,
    audit,
    configSync: new ConfigSync({
      prisma,
      git: engineServices.git,
      allowedGitHosts: config.allowedGitHosts,
      logger: logger.child({ component: "config" }),
    }),
    engine: engineServices.engine,
    environment,
    router: engineServices.router,
    buildLogs: new BuildLogStore(config.dataDir),
    allowedGitHosts: config.allowedGitHosts,
    logger: logger.child({ component: "deployments" }),
  });
  const projects = new ProjectService({
    prisma,
    access,
    audit,
    git: engineServices.git,
    deployments,
    allowedGitHosts: config.allowedGitHosts,
    logger: logger.child({ component: "projects" }),
  });

  const webhooks = config.githubWebhookSecret
    ? {
        service: new WebhookService({ prisma, deployments, logger: logger.child({ component: "webhooks" }) }),
        secret: config.githubWebhookSecret,
      }
    : null;

  const domains = new DomainService({
    prisma,
    deployments,
    publicDomain: config.routing?.domain ?? null,
    https: Boolean(config.routing?.tls),
    access,
    audit,
    logger: logger.child({ component: "domains" }),
  });

  const services = new ServiceService({ prisma, access, deployments, audit, logger: logger.child({ component: "services" }) });
  const volumes = new VolumeService({ prisma, access, audit, logger: logger.child({ component: "volumes" }) });
  const auth = createAuth(config, prisma, secretBox, audit, logger);
  return { ...engineServices, prisma, projects, deployments, environment, domains, audit, organizations, services, volumes, auth, webhooks };
}

function createAuth(
  config: AppConfig,
  prisma: PrismaClient,
  secretBox: SecretBox | null,
  audit: AuditService,
  logger: Logger,
): AppAuth | null {
  const { github: githubConfig } = config.auth;
  if (!githubConfig || !secretBox) return null; // config validation guarantees both or neither

  const github = new GitHubClient(githubConfig);
  const service = new AuthService({
    prisma,
    github,
    secretBox,
    redirectUri: `${config.publicUrl}/api/auth/github/callback`,
    sessionTtlMs: config.auth.sessionTtlMs,
    allowedUsers: config.auth.allowedUsers,
    logger: logger.child({ component: "auth" }),
  });
  return {
    service,
    github,
    sessionCookie: sessionCookieName(config.auth.secureCookies),
    secureCookies: config.auth.secureCookies,
    appUrl: config.appUrl,
    apiKeys: new ApiKeyService({ prisma, audit, logger: logger.child({ component: "api-keys" }) }),
  };
}
