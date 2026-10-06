import type { PrismaClient, Project, Service } from "../../db/prisma.js";
import { ConflictError, ErrorCode, ValidationError } from "../../lib/errors.js";
import type { EnvironmentService } from "../environment/EnvironmentService.js";
import { MAX_ENV_VARS_PER_PROJECT } from "../environment/environment.schemas.js";
import {
  POSTGRES_DATA_PATH,
  POSTGRES_DATA_VOLUME,
  POSTGRES_PASSWORD_KEY,
  POSTGRES_PORT,
  type PostgresVersion,
  connectionUrl,
  connectionVariable,
  generatePassword,
  postgresImage,
} from "./postgres.js";
import { dockerVolumeName } from "./VolumeService.js";

export interface ProvisionedDatabase {
  service: Service;
  /** The project-wide variable holding its URL, e.g. DATABASE_URL. */
  variable: string;
}

/**
 * Creates a PostgreSQL service in one transaction: the service, its data
 * volume, a generated password (a secret only the database gets) and the
 * connection URL (a secret every service of the project gets). Nothing is
 * started until the next deploy.
 */
export async function provisionPostgres(
  deps: { prisma: PrismaClient; environment: Pick<EnvironmentService, "sealedRows"> },
  project: Pick<Project, "id">,
  input: { name: string; version: PostgresVersion; managedBy?: "DASHBOARD" | "CONFIG_FILE" },
): Promise<ProvisionedDatabase> {
  return deps.prisma.$transaction(async (tx) => {
    const projectVariables = await tx.environmentVariable.findMany({ where: { projectId: project.id }, select: { key: true, scope: true, environment: true } });
    if (projectVariables.length + 2 > MAX_ENV_VARS_PER_PROJECT) {
      throw new ValidationError(`A database needs 2 environment variables, and a project can have at most ${MAX_ENV_VARS_PER_PROJECT}.`);
    }
    const variable = connectionVariable(
      input.name,
      new Set(projectVariables.filter((v) => v.scope === "project" && v.environment === "ALL").map((v) => v.key)),
    );
    if (!variable) {
      throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `DATABASE_URL and ${input.name.toUpperCase()}_DATABASE_URL are both taken. Delete one, or name the database differently.`);
    }
    const service = await tx.service.create({
      data: {
        projectId: project.id,
        name: input.name,
        type: "POSTGRES",
        image: postgresImage(input.version),
        port: POSTGRES_PORT,
        public: false,
        managedBy: input.managedBy ?? "DASHBOARD",
      },
    });
    await tx.volume.create({
      data: {
        serviceId: service.id,
        name: POSTGRES_DATA_VOLUME,
        mountPath: POSTGRES_DATA_PATH,
        dockerName: dockerVolumeName(service.id, POSTGRES_DATA_VOLUME),
      },
    });
    const password = generatePassword();
    await tx.environmentVariable.createMany({
      data: deps.environment.sealedRows(project.id, [
        { serviceId: service.id, key: POSTGRES_PASSWORD_KEY, value: password, secret: true },
        { serviceId: null, key: variable, value: connectionUrl(input.name, password), secret: true },
      ]),
    });
    return { service, variable };
  });
}
