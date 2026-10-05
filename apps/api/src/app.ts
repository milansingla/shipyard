import express, { type Express } from "express";

import type { Logger } from "./lib/logger.js";
import { createErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { createDeploymentRouter } from "./modules/deployments/deployment.routes.js";
import type { DeploymentService } from "./modules/deployments/DeploymentService.js";
import { createProjectRouter } from "./modules/projects/project.routes.js";
import type { ProjectService } from "./modules/projects/ProjectService.js";
import { createHealthRouter } from "./routes/health.js";
import type { DockerService } from "./services/docker/DockerService.js";

export interface AppDeps {
  docker: Pick<DockerService, "ping">;
  /** Optional so the app can be tested without a database. */
  projects?: ProjectService;
  deployments?: DeploymentService;
  logger: Logger;
  exposeInternalErrors: boolean;
}

/** Builds the Express app without starting it — tests mount it on a random port. */
export function createApp({ docker, projects, deployments, logger, exposeInternalErrors }: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestLogger(logger)); // first, so even requests rejected by the body parser are logged
  app.use(express.json({ limit: "100kb" }));

  app.use("/api", createHealthRouter(docker));
  if (projects && deployments) {
    app.use("/api", createProjectRouter(projects, deployments));
    app.use("/api", createDeploymentRouter(deployments));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger, exposeInternalErrors));

  return app;
}
