import type { EnvironmentVariable, PrismaClient } from "../../db/prisma.js";
import { AppError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { SecretBox } from "../../lib/secretBox.js";
import type { AuditService } from "../audit/AuditService.js";
import { MAX_ENV_VARS_PER_PROJECT, type SetEnvVarInput } from "./environment.schemas.js";

/** What the API returns. A secret's value is never sent back, only that it is set. */
export interface EnvironmentVariableView {
  key: string;
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

  async list(projectId: string, ownerId: string): Promise<EnvironmentVariableView[]> {
    await this.assertOwner(projectId, ownerId);
    const rows = await this.deps.prisma.environmentVariable.findMany({ where: { projectId }, orderBy: { key: "asc" } });
    return rows.map((row) => this.view(row));
  }

  /** Creates or replaces a variable. */
  async set(projectId: string, ownerId: string, key: string, input: SetEnvVarInput): Promise<EnvironmentVariableView> {
    const project = await this.assertOwner(projectId, ownerId);
    const { prisma, secretBox } = this.deps;

    const exists = await prisma.environmentVariable.findUnique({ where: { projectId_key: { projectId, key } } });
    if (!exists && (await prisma.environmentVariable.count({ where: { projectId } })) >= MAX_ENV_VARS_PER_PROJECT) {
      throw new ValidationError(`A project can have at most ${MAX_ENV_VARS_PER_PROJECT} environment variables.`);
    }

    const data = {
      value: secretBox.encrypt(input.value, sealContext(projectId, key)),
      secret: input.secret,
      target: input.target,
    };
    const row = await prisma.environmentVariable.upsert({
      where: { projectId_key: { projectId, key } },
      create: { projectId, key, ...data },
      update: data,
    });
    // Names are logged, never values.
    this.deps.logger.info({ projectId, key, secret: row.secret, target: row.target }, "Environment variable saved");
    await this.deps.audit.record({
      action: "ENV_VAR_SET",
      actorId: ownerId,
      project,
      metadata: { key, secret: row.secret, target: row.target },
    });
    return this.view(row);
  }

  async remove(projectId: string, ownerId: string, key: string): Promise<void> {
    const project = await this.assertOwner(projectId, ownerId);
    const { count } = await this.deps.prisma.environmentVariable.deleteMany({ where: { projectId, key } });
    if (count === 0) throw new NotFoundError(`Environment variable not found: ${key}`);
    this.deps.logger.info({ projectId, key }, "Environment variable deleted");
    await this.deps.audit.record({ action: "ENV_VAR_DELETED", actorId: ownerId, project, metadata: { key } });
  }

  /**
   * Decrypted values for a deployment. No ownership check: only the deploy
   * pipeline calls this, for a project whose access it already checked.
   */
  async forDeployment(projectId: string): Promise<DeploymentEnvironment> {
    const rows = await this.deps.prisma.environmentVariable.findMany({ where: { projectId } });
    const environment: DeploymentEnvironment = { runtime: {}, build: {} };
    for (const row of rows) {
      const value = this.reveal(row);
      if (row.target !== "BUILD") environment.runtime[row.key] = value;
      // Defence in depth: the API already refuses secrets as build variables.
      if (row.target !== "RUNTIME" && !row.secret) environment.build[row.key] = value;
    }
    return environment;
  }

  private view(row: EnvironmentVariable): EnvironmentVariableView {
    return {
      key: row.key,
      value: row.secret ? null : this.reveal(row),
      secret: row.secret,
      target: row.target,
      updatedAt: row.updatedAt,
    };
  }

  private reveal(row: EnvironmentVariable): string {
    try {
      return this.deps.secretBox.decrypt(row.value, sealContext(row.projectId, row.key));
    } catch {
      throw new AppError(
        ErrorCode.SECRET_UNREADABLE,
        `Environment variable ${row.key} can't be decrypted. Was SHIPYARD_SECRET_KEY changed? Set the variable again.`,
        { statusCode: 422 },
      );
    }
  }

  private async assertOwner(projectId: string, ownerId: string): Promise<{ id: string; name: string; ownerId: string }> {
    const project = await this.deps.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true, name: true, ownerId: true },
    });
    if (!project) throw new NotFoundError(`Project not found: ${projectId}`);
    return project;
  }
}

function sealContext(projectId: string, key: string): string {
  return `env:${projectId}:${key}`;
}
