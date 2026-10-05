import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "../generated/prisma/client.js";

export { Prisma, PrismaClient };
export type { CronJob, CronRun, Deployment, EnvironmentVariable, Organization, Project, Service, User, Volume } from "../generated/prisma/client.js";
export { AuditAction, DeploymentEventType, DeploymentTrigger, OrgRole } from "../generated/prisma/enums.js";

/**
 * Prisma 7 talks to Postgres through a driver adapter (node-postgres here)
 * instead of a bundled Rust query engine. Create ONE client per process —
 * it owns a connection pool.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

/** Unique-constraint violation (e.g. duplicate project slug). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** "Record to update/delete does not exist." */
export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}
