import { randomBytes } from "node:crypto";

/**
 * PostgreSQL services: the official image, its data on a volume, reachable
 * only on the project's private network. Self-hosted: no backups, failover
 * or point-in-time recovery (see docs/databases.md).
 */

export const POSTGRES_VERSIONS = [16, 17] as const;
export type PostgresVersion = (typeof POSTGRES_VERSIONS)[number];
export const DEFAULT_POSTGRES_VERSION: PostgresVersion = 17;

export const POSTGRES_PORT = 5432;
/** Role and database the image creates on first start. Fixed: the health check and the URL use them. */
export const POSTGRES_USER = "app";
export const POSTGRES_DB = "app";
/** Where the official image keeps its data (PGDATA) for these versions. */
export const POSTGRES_DATA_PATH = "/var/lib/postgresql/data";
export const POSTGRES_DATA_VOLUME = "data";
/** The service-scoped secret holding the password. Only read by the image on first start. */
export const POSTGRES_PASSWORD_KEY = "POSTGRES_PASSWORD";

export function postgresImage(version: PostgresVersion): string {
  return `postgres:${version}-alpine`;
}

/** The major version of a stored image name, or null if it isn't one of ours. */
export function postgresVersionOf(image: string | null): PostgresVersion | null {
  const match = /^postgres:(\d+)-alpine$/.exec(image ?? "");
  const version = match ? Number(match[1]) : NaN;
  return (POSTGRES_VERSIONS as readonly number[]).includes(version) ? (version as PostgresVersion) : null;
}

/** 32 random bytes, base64url: safe to put in a URL unescaped. */
export function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

export function connectionUrl(serviceName: string, password: string): string {
  return `postgres://${POSTGRES_USER}:${password}@${serviceName}:${POSTGRES_PORT}/${POSTGRES_DB}`;
}

/**
 * The project-wide variable the other services read: DATABASE_URL for the
 * first database, <NAME>_DATABASE_URL (db-2 → DB_2_DATABASE_URL) when taken.
 */
export function connectionVariable(serviceName: string, taken: ReadonlySet<string>): string | null {
  if (!taken.has("DATABASE_URL")) return "DATABASE_URL";
  const named = `${serviceName.toUpperCase().replace(/-/g, "_")}_DATABASE_URL`;
  return taken.has(named) ? null : named;
}

/** Docker runs this inside the container: ready once the server accepts TCP connections (not just its init socket). */
export function postgresHealthCommand(): string[] {
  return ["pg_isready", "-h", "127.0.0.1", "-p", String(POSTGRES_PORT), "-U", POSTGRES_USER, "-d", POSTGRES_DB];
}
