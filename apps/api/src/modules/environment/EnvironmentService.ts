import type { EnvironmentVariable, Prisma, PrismaClient } from "../../db/prisma.js";
import { AppError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { SecretProvider } from "../../lib/secrets.js";
import { OrgRole } from "../../db/prisma.js";
import { type AccessService, atLeast } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";
import {
  type DeploymentEnvironmentName,
  MAX_ENV_VARS_PER_PROJECT,
  type SetEnvVarInput,
  type VariableEnvironmentName,
} from "./environment.schemas.js";

/** What the API returns. A secret's value is never sent back, only that it is set. */
export interface EnvironmentVariableView {
  key: string;
  /** null = every service of the project; otherwise the one service it applies to. */
  serviceId: string | null;
  /** ALL, or the one environment it applies to. */
  environment: VariableEnvironmentName;
  /** null for secrets. */
  value: string | null;
  secret: boolean;
  target: EnvironmentVariable["target"];
  updatedAt: Date;
}

/** Decrypted variables for one deployment, split by when they are used. */
export interface DeploymentEnvironment {
  runtime: Record<string, string>;
  build: Record<string, string>;
}

export interface EnvironmentServiceDeps {
  prisma: PrismaClient;
  secretBox: SecretProvider;
  access: AccessService;
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

/**
 * A project's environment variables and secrets.
 *
 * Every value is encrypted at rest, secret or not, bound to its project and
 * key so a ciphertext copied to another row won't decrypt. Values are
 * decrypted only in forDeployment(), just before they are handed to Docker.
 * Changes apply to the next deployment: a running container keeps the
 * environment it was started with, which is also what makes rollback exact.
 */
export class EnvironmentService {
  constructor(private readonly deps: EnvironmentServiceDeps) {}

  /** VIEWERs see names and settings only; values need DEVELOPER (secrets: never). */
  async list(projectId: string, userId: string): Promise<EnvironmentVariableView[]> {
    const { role } = await this.deps.access.project(projectId, userId);
    const rows = await this.deps.prisma.environmentVariable.findMany({
      where: { projectId },
      orderBy: [{ key: "asc" }, { scope: "asc" }, { environment: "asc" }],
    });
    const showValues = atLeast(role, OrgRole.DEVELOPER);
    return rows.map((row) => ({ ...this.view(row, showValues) }));
  }

  /** Creates or replaces a variable, for every service or (serviceId) just one. */
  async set(
    projectId: string,
    userId: string,
    key: string,
    input: SetEnvVarInput,
    serviceId: string | null = null,
    environment: VariableEnvironmentName = "ALL",
  ): Promise<EnvironmentVariableView> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.DEVELOPER);
    const { prisma, secretBox } = this.deps;
    const scope = await this.scopeFor(projectId, serviceId);

    const where = { projectId_scope_environment_key: { projectId, scope, environment, key } };
    const exists = await prisma.environmentVariable.findUnique({ where });
    if (!exists && (await prisma.environmentVariable.count({ where: { projectId } })) >= MAX_ENV_VARS_PER_PROJECT) {
      throw new ValidationError(`A project can have at most ${MAX_ENV_VARS_PER_PROJECT} environment variables.`);
    }

    const data = {
      value: secretBox.encrypt(input.value, sealContext(projectId, scope, key, environment)),
      secret: input.secret,
      target: input.target,
    };
    const row = await prisma.environmentVariable.upsert({
      where,
      create: { projectId, scope, key, environment, ...data },
      update: data,
    });
    // Names are logged, never values.
    this.deps.logger.info({ projectId, key, secret: row.secret, target: row.target }, "Environment variable saved");
    await this.deps.audit.record({
      action: "ENV_VAR_SET",
      actorId: userId,
      project,
      metadata: { key, secret: row.secret, target: row.target, ...(serviceId && { serviceId }), ...(environment !== "ALL" && { environment }) },
    });
    return this.view(row);
  }

  async remove(
    projectId: string,
    userId: string,
    key: string,
    serviceId: string | null = null,
    environment: VariableEnvironmentName = "ALL",
  ): Promise<void> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.DEVELOPER);
    const scope = await this.scopeFor(projectId, serviceId);
    const { count } = await this.deps.prisma.environmentVariable.deleteMany({ where: { projectId, scope, environment, key } });
    if (count === 0) throw new NotFoundError(`Environment variable not found: ${key}`);
    this.deps.logger.info({ projectId, key }, "Environment variable deleted");
    await this.deps.audit.record({ action: "ENV_VAR_DELETED", actorId: userId, project, metadata: { key } });
  }

  /**
   * Decrypted values for one service's deployment: the project's variables,
   * overridden by the service's own. No ownership check: only the deploy
   * pipeline calls this, for a project whose access it already checked.
   */
  async forDeployment(
    projectId: string,
    serviceId?: string,
    where: DeploymentEnvironmentName = "PRODUCTION",
  ): Promise<DeploymentEnvironment> {
    const rows = (
      await this.deps.prisma.environmentVariable.findMany({
        where: {
          projectId,
          scope: { in: [PROJECT_SCOPE, ...(serviceId ? [serviceId] : [])] },
          environment: { in: ["ALL", where] },
        },
      })
    ).filter(
      // A secret set for ALL is a production secret: a preview runs code from a pull
      // request, so it only ever gets secrets set for PREVIEW explicitly.
      (row) => !(where === "PREVIEW" && row.secret && row.environment === "ALL"),
    );
    // Least specific first, so the more specific value overwrites it:
    // project-wide < project-wide for this environment < the service's < the service's for this environment.
    const rank = (row: EnvironmentVariable) => (row.scope === PROJECT_SCOPE ? 0 : 2) + (row.environment === "ALL" ? 0 : 1);
    rows.sort((a, b) => rank(a) - rank(b));
    const environment: DeploymentEnvironment = { runtime: {}, build: {} };
    for (const row of rows) {
      const value = this.reveal(row);
      if (row.target !== "BUILD") environment.runtime[row.key] = value;
      // Defence in depth: the API already refuses secrets as build variables.
      if (row.target !== "RUNTIME" && !row.secret) environment.build[row.key] = value;
    }
    return environment;
  }

  /**
   * The decrypted values of these projects' secrets, to mask them in text
   * that leaves Shipyard (the AI assistant's prompts). No access check: the
   * caller has done it, and the values never leave the process.
   */
  async secretValues(projectIds: readonly string[]): Promise<string[]> {
    const rows = await this.deps.prisma.environmentVariable.findMany({ where: { projectId: { in: [...projectIds] }, secret: true } });
    // Very short values would mask ordinary text without protecting anything.
    return rows.map((row) => this.reveal(row)).filter((value) => value.length >= 4);
  }

  /**
   * Encrypted rows for variables Shipyard sets itself (a database's password
   * and URL), to be written in the caller's transaction. No access check:
   * the caller has done it.
   */
  sealedRows(
    projectId: string,
    variables: ReadonlyArray<{ serviceId: string | null; key: string; value: string; secret: boolean }>,
  ): Prisma.EnvironmentVariableCreateManyInput[] {
    return variables.map(({ serviceId, key, value, secret }) => {
      const scope = serviceId ?? PROJECT_SCOPE;
      return {
        projectId,
        scope,
        key,
        value: this.deps.secretBox.encrypt(value, sealContext(projectId, scope, key)),
        secret,
        target: "RUNTIME" as const,
      };
    });
  }

  /** "project", or the id of a service that belongs to the project. */
  private async scopeFor(projectId: string, serviceId: string | null): Promise<string> {
    if (!serviceId) return PROJECT_SCOPE;
    const service = await this.deps.prisma.service.findFirst({ where: { id: serviceId, projectId }, select: { id: true } });
    if (!service) throw new NotFoundError(`Service not found: ${serviceId}`);
    return service.id;
  }

  private view(row: EnvironmentVariable, showValue = true): EnvironmentVariableView {
    return {
      key: row.key,
      serviceId: row.scope === PROJECT_SCOPE ? null : row.scope,
      environment: row.environment,
      value: row.secret || !showValue ? null : this.reveal(row),
      secret: row.secret,
      target: row.target,
      updatedAt: row.updatedAt,
    };
  }

  private reveal(row: EnvironmentVariable): string {
    try {
      return this.deps.secretBox.decrypt(row.value, sealContext(row.projectId, row.scope, row.key, row.environment));
    } catch {
      throw new AppError(
        ErrorCode.SECRET_UNREADABLE,
        `Environment variable ${row.key} can't be decrypted. Was SHIPYARD_SECRET_KEY changed? Set the variable again.`,
        { statusCode: 422 },
      );
    }
  }


}

const PROJECT_SCOPE = "project";

/**
 * Binds a ciphertext to its project, scope, key and environment, so a value
 * copied to another row (say, from PRODUCTION to PREVIEW) won't decrypt.
 * Earlier formats are kept: project-wide values have no scope part, ALL no environment part.
 */
function sealContext(projectId: string, scope: string, key: string, environment: VariableEnvironmentName = "ALL"): string {
  const base = scope === PROJECT_SCOPE ? `env:${projectId}:${key}` : `env:${projectId}:${scope}:${key}`;
  return environment === "ALL" ? base : `${base}@${environment}`;
}
