import express, { type Express } from "express";

import type { Logger } from "./lib/logger.js";
import { createErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { authenticate, requireUser } from "./middleware/authenticate.js";
import { originCheck } from "./middleware/originCheck.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import type { AuthService } from "./modules/auth/AuthService.js";
import { createDeploymentRouter } from "./modules/deployments/deployment.routes.js";
import type { DeploymentService } from "./modules/deployments/DeploymentService.js";
import { createGitHubRouter } from "./modules/github/github.routes.js";
import { createProjectRouter } from "./modules/projects/project.routes.js";
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
}

export interface AppDeps {
  docker: Pick<DockerService, "ping">;
  /** Optional so the app can be tested without a database. */
  projects?: ProjectService;
  deployments?: DeploymentService;
  /** null/omitted = GitHub sign-in not configured: protected routes answer 503. */
  auth?: AppAuth | null;
  /** Origins allowed to make state-changing browser requests (the API's and the dashboard's). */
  allowedOrigins?: readonly string[];
  logger: Logger;
  exposeInternalErrors: boolean;
}

/** Builds the Express app without starting it — tests mount it on a random port. */
export function createApp(deps: AppDeps): Express {
  const { docker, projects, deployments, auth, logger, exposeInternalErrors } = deps;
  const app = express();

  app.disable("x-powered-by");
  app.locals.authConfigured = Boolean(auth);
  app.use(requestLogger(logger)); // first, so even requests rejected by the body parser are logged
  app.use(originCheck(deps.allowedOrigins ?? []));
  app.use(express.json({ limit: "100kb" }));

  app.use("/api", createHealthRouter(docker));
  if (auth) {
    app.use("/api", authenticate(auth.service, auth.sessionCookie));
    app.use("/api", createAuthRouter(auth.service, auth));
    app.use("/api", createGitHubRouter(auth.service, auth.github));
  } else {
    // Answer sign-in routes with the setup instructions (503) rather than a bare 404,
    // so the dashboard can tell the operator what to configure.
    app.use(["/api/auth", "/api/github"], (req) => void requireUser(req));
  }
  if (projects && deployments) {
    app.use("/api", createProjectRouter(projects, deployments));
    app.use("/api", createDeploymentRouter(deployments));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger, exposeInternalErrors));

  return app;
}
