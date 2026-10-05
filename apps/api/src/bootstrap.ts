import Docker from "dockerode";

import type { AppConfig } from "./config/env.js";
import type { Logger } from "./lib/logger.js";
import { DeploymentService } from "./services/deployment/DeploymentService.js";
import { HealthCheckService } from "./services/deployment/HealthCheckService.js";
import { DockerService } from "./services/docker/DockerService.js";
import { GitService } from "./services/git/GitService.js";
import { WorkspaceService } from "./services/workspace/WorkspaceService.js";

export interface Services {
  docker: DockerService;
  deployments: DeploymentService;
}

/**
 * Composition root: the ONE place where concrete services are constructed and
 * wired together. Everything else receives its dependencies as arguments,
 * which is what makes the services testable with fakes.
 */
export function createServices(config: AppConfig, logger: Logger): Services {
  // Dockerode honours DOCKER_HOST; otherwise it uses the local Docker socket.
  const docker = new DockerService(new Docker(), { publishHost: config.publishHost }, logger.child({ component: "docker" }));

  const deployments = new DeploymentService({
    source: new GitService({ cloneTimeoutMs: config.gitCloneTimeoutMs }, logger.child({ component: "git" })),
    docker,
    healthCheck: new HealthCheckService(config.healthCheck),
    workspace: new WorkspaceService(config.workspaceDir),
    logger: logger.child({ component: "deployment" }),
    allowedGitHosts: config.allowedGitHosts,
  });

  return { docker, deployments };
}
