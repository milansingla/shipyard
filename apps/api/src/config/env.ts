import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { AppError, ErrorCode } from "../lib/errors.js";

// Resolves to <repo root>/.env from both src/config and dist/config.
const ROOT_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  // Optional here because the CLI doesn't need it; the API server requires it.
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgresql:// connection string")
    .optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  SHIPYARD_WORKSPACE_DIR: z.string().min(1).optional(),
  SHIPYARD_DATA_DIR: z.string().min(1).optional(),
  SHIPYARD_ALLOWED_GIT_HOSTS: z.string().default("github.com"),
  // Restricted to two values until Traefik replaces host-port publishing.
  SHIPYARD_PUBLISH_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  SHIPYARD_HEALTHCHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  SHIPYARD_GIT_CLONE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  SHIPYARD_BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string | null;
  logLevel: LogLevel;
  /** True when LOG_LEVEL was set explicitly (the CLI uses a quieter default otherwise). */
  logLevelExplicit: boolean;
  workspaceDir: string;
  /** Persistent data such as build logs. */
  dataDir: string;
  allowedGitHosts: string[];
  publishHost: "127.0.0.1" | "0.0.0.0";
  gitCloneTimeoutMs: number;
  buildTimeoutMs: number;
  healthCheck: {
    timeoutMs: number;
    intervalMs: number;
    requestTimeoutMs: number;
  };
}

/** Pure: turns an env-like object into validated config. Throws on invalid input. */
export function parseConfig(rawEnv: NodeJS.ProcessEnv): AppConfig {
  // `PORT=` in a .env file means "use the default", not "port 0".
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, value]) => value !== ""));

  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      `Invalid environment configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  const parsed = result.data;

  const allowedGitHosts = parsed.SHIPYARD_ALLOWED_GIT_HOSTS.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (allowedGitHosts.length === 0) {
    throw new AppError(ErrorCode.CONFIG_INVALID, "SHIPYARD_ALLOWED_GIT_HOSTS must list at least one host.");
  }

  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL ?? null,
    logLevel: parsed.LOG_LEVEL,
    logLevelExplicit: env.LOG_LEVEL !== undefined,
    workspaceDir: path.resolve(
      parsed.SHIPYARD_WORKSPACE_DIR ?? path.join(os.tmpdir(), "shipyard", "workspaces"),
    ),
    dataDir: path.resolve(parsed.SHIPYARD_DATA_DIR ?? path.join(os.homedir(), ".shipyard")),
    allowedGitHosts,
    publishHost: parsed.SHIPYARD_PUBLISH_HOST,
    gitCloneTimeoutMs: parsed.SHIPYARD_GIT_CLONE_TIMEOUT_MS,
    buildTimeoutMs: parsed.SHIPYARD_BUILD_TIMEOUT_MS,
    healthCheck: {
      timeoutMs: parsed.SHIPYARD_HEALTHCHECK_TIMEOUT_MS,
      intervalMs: 1_000,
      requestTimeoutMs: 3_000,
    },
  };
}

/** For entrypoints that need the database (the API server). */
export function requireDatabaseUrl(config: AppConfig): string {
  if (!config.databaseUrl) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      "DATABASE_URL is not set. Start Postgres with `npm run db:up` and copy .env.example to .env.",
    );
  }
  return config.databaseUrl;
}

/** Loads <repo root>/.env (if present) into process.env, then parses it. Call once, at an entrypoint. */
export function loadConfig(): AppConfig {
  try {
    // Does not override variables already set in the real environment.
    process.loadEnvFile(ROOT_ENV_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return parseConfig(process.env);
}
