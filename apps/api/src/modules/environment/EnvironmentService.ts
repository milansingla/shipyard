import type { EnvironmentVariable, PrismaClient } from "../../db/prisma.js";
import { AppError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { SecretBox } from "../../lib/secretBox.js";
import { OrgRole } from "../../db/prisma.js";
import { type AccessService, atLeast } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";
import { MAX_ENV_VARS_PER_PROJECT, type SetEnvVarInput } from "./environment.schemas.js";

/** What the API returns. A secret's value is never sent back, only that it is set. */
export interface EnvironmentVariableView {
  key: string;
  /** null = every service of the project; otherwise the one service it applies to. */
  serviceId: string | null;
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
  secretBox: SecretBox;
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
      orderBy: [{ key: "asc" }, { scope: "asc" }],
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
  ): Promise<EnvironmentVariableView> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.DEVELOPER);
    const { prisma, secretBox } = this.deps;
    const scope = await this.scopeFor(projectId, serviceId);

    const exists = await prisma.environmentVariable.findUnique({ where: { projectId_scope_key: { projectId, scope, key } } });
    if (!exists && (await prisma.environmentVariable.count({ where: { projectId } })) >= MAX_ENV_VARS_PER_PROJECT) {
      throw new ValidationError(`A project can have at most ${MAX_ENV_VARS_PER_PROJECT} environment variables.`);
    }

    const data = {
      value: secretBox.encrypt(input.value, sealContext(projectId, scope, key)),
      secret: input.secret,
      target: input.target,
    };
    const row = await prisma.environmentVariable.upsert({
      where: { projectId_scope_key: { projectId, scope, key } },
      create: { projectId, scope, key, ...data },
      update: data,
    });
    // Names are logged, never values.
    this.deps.logger.info({ projectId, key, secret: row.secret, target: row.target }, "Environment variable saved");
    await this.deps.audit.record({
      action: "ENV_VAR_SET",
      actorId: userId,
      project,
      metadata: { key, secret: row.secret, target: row.target, ...(serviceId && { serviceId }) },
    });
    return this.view(row);
  }

  async remove(projectId: string, userId: string, key: string, serviceId: string | null = null): Promise<void> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.DEVELOPER);
    const scope = await this.scopeFor(projectId, serviceId);
    const { count } = await this.deps.prisma.environmentVariable.deleteMany({ where: { projectId, scope, key } });
    if (count === 0) throw new NotFoundError(`Environment variable not found: ${key}`);
    this.deps.logger.info({ projectId, key }, "Environment variable deleted");
    await this.deps.audit.record({ action: "ENV_VAR_DELETED", actorId: userId, project, metadata: { key } });
  }

  /**
   * Decrypted values for one service's deployment: the project's variables,
   * overridden by the service's own. No ownership check: only the deploy
   * pipeline calls this, for a project whose access it already checked.
   */
  async forDeployment(projectId: string, serviceId?: string): Promise<DeploymentEnvironment> {
    const rows = await this.deps.prisma.environmentVariable.findMany({
      where: { projectId, scope: { in: [PROJECT_SCOPE, ...(serviceId ? [serviceId] : [])] } },
    });
    // Project-wide first, so a service's own value overwrites it.
    rows.sort((a, b) => Number(a.scope !== PROJECT_SCOPE) - Number(b.scope !== PROJECT_SCOPE));
    const environment: DeploymentEnvironment = { runtime: {}, build: {} };
    for (const row of rows) {
      const value = this.reveal(row);
      if (row.target !== "BUILD") environment.runtime[row.key] = value;
      // Defence in depth: the API already refuses secrets as build variables.
      if (row.target !== "RUNTIME" && !row.secret) environment.build[row.key] = value;
    }
    return environment;
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
      value: row.secret || !showValue ? null : this.reveal(row),
      secret: row.secret,
      target: row.target,
      updatedAt: row.updatedAt,
    };
  }

  private reveal(row: EnvironmentVariable): string {
    try {
      return this.deps.secretBox.decrypt(row.value, sealContext(row.projectId, row.scope, row.key));
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

/** Binds a ciphertext to its project, scope and key (project-wide values keep the original format). */
function sealContext(projectId: string, scope: string, key: string): string {
  return scope === PROJECT_SCOPE ? `env:${projectId}:${key}` : `env:${projectId}:${scope}:${key}`;
}
