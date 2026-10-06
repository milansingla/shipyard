import type { Environment } from "../../db/prisma.js";
import type { DeploymentEnvironmentName } from "../environment/environment.schemas.js";

/**
 * Pure rules for environments besides production. Production is the project
 * itself (deployments with no environment); a development environment is
 * "dev", a pull request's preview "pr-<number>". The name prefixes the
 * production route name: dev-shop.<domain>, pr-12-shop.<domain>.
 */

export const DEVELOPMENT_NAME = "dev";

export function previewName(pullRequest: number): string {
  return `pr-${pullRequest}`;
}

/** First hostname label of a service in an environment (production: unchanged). */
export function environmentRouteName(environment: Pick<Environment, "name"> | null, productionRouteName: string): string {
  return environment ? `${environment.name}-${productionRouteName}` : productionRouteName;
}

/** Which variables a deployment in this environment gets. */
export function variableEnvironment(environment: Pick<Environment, "type"> | null): DeploymentEnvironmentName {
  return environment ? environment.type : "PRODUCTION";
}

/** Names environments use as hostname prefixes: projects and services can't take them. */
export const RESERVED_PREFIX = /^(?:dev|pr-\d+)(?:-|$)/;
