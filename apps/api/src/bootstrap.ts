import Docker from "dockerode";

import type { AppConfig } from "./config/env.js";
import { type PrismaClient, createPrismaClient } from "./db/prisma.js";
import type { Logger } from "./lib/logger.js";
import { BuildLogStore } from "./modules/deployments/BuildLogStore.js";
import { DeploymentService } from "./modules/deployments/DeploymentService.js";
import { ProjectService } from "./modules/projects/ProjectService.js";
import { DeploymentEngine } from "./services/deployment/DeploymentEngine.js";
import { HealthCheckService } from "./services/deployment/HealthCheckService.js";
import { DockerService } from "./services/docker/DockerService.js";
import { GitService } from "./services/git/GitService.js";
import { WorkspaceService } from "./services/workspace/WorkspaceService.js";

export interface EngineServices {
  docker: DockerService;
  git: GitService;
  engine: DeploymentEngine;
}

export interface ApiServices extends EngineServices {
  prisma: PrismaClient;
  projects: ProjectService;
  deployments: DeploymentService;
}

/**
 * Composition root: the ONE place where concrete services are constructed and
 * wired together. Everything else receives its dependencies as arguments,
 * which is what makes the services testable with fakes.
 */
export function createEngineServices(config: AppConfig, logger: Logger): EngineServices {
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
    logger: logger.child({ component: "engine" }),
  });

  return { docker, git, engine };
}

/** Everything the HTTP API needs, including the database. */
export function createApiServices(config: AppConfig, databaseUrl: string, logger: Logger): ApiServices {
  const engineServices = createEngineServices(config, logger);
  const prisma = createPrismaClient(databaseUrl);

  const deployments = new DeploymentService({
    prisma,
    engine: engineServices.engine,
    buildLogs: new BuildLogStore(config.dataDir),
    allowedGitHosts: config.allowedGitHosts,
    logger: logger.child({ component: "deployments" }),
  });
  const projects = new ProjectService({
    prisma,
    git: engineServices.git,
    deployments,
    allowedGitHosts: config.allowedGitHosts,
    logger: logger.child({ component: "projects" }),
  });

  return { ...engineServices, prisma, projects, deployments };
}
