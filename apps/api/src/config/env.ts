import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { AppError, ErrorCode } from "../lib/errors.js";
import { parseSecretKey } from "../lib/secretBox.js";

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
  /** Where browsers reach this API; used for the OAuth callback URL. Default http://localhost:<PORT>. */
  SHIPYARD_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Where the browser is sent after signing in (the dashboard). Default: SHIPYARD_PUBLIC_URL. */
  SHIPYARD_APP_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** 32 random bytes, base64. Encrypts stored GitHub tokens. */
  SHIPYARD_SECRET_KEY: z.string().optional(),
  SHIPYARD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(24 * 30),
  /** Comma-separated GitHub logins allowed to sign in, or "*" for anyone. Required with GitHub sign-in. */
  SHIPYARD_ALLOWED_GITHUB_USERS: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  /** Shared secret for GitHub push webhooks. Unset = webhooks disabled (503). */
  GITHUB_WEBHOOK_SECRET: z.string().min(20, "must be at least 20 characters (`openssl rand -hex 32`)").optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
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
  /** Origin + path where browsers reach the API, no trailing slash. */
  publicUrl: string;
  /** Where to send the browser after sign-in, no trailing slash. */
  appUrl: string;
  auth: {
    /** null = GitHub sign-in not configured; protected endpoints are then unusable. */
    github: { clientId: string; clientSecret: string } | null;
    /** Lower-cased logins allowed to sign in, or "*" (anyone with a GitHub account). */
    allowedUsers: readonly string[] | "*";
    secretKey: Buffer | null;
    sessionTtlMs: number;
    /** Secure cookies whenever the API is served over HTTPS. */
    secureCookies: boolean;
  };
  /** null = push webhooks disabled. */
  githubWebhookSecret: string | null;
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

  const publicUrl = trimTrailingSlash(parsed.SHIPYARD_PUBLIC_URL ?? `http://localhost:${parsed.PORT}`);

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
    publicUrl,
    appUrl: trimTrailingSlash(parsed.SHIPYARD_APP_URL ?? publicUrl),
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET ?? null,
    auth: {
      ...parseAuth(parsed),
      sessionTtlMs: parsed.SHIPYARD_SESSION_TTL_HOURS * 60 * 60 * 1000,
      secureCookies: publicUrl.startsWith("https://"),
    },
  };
}

function parseAuth(parsed: z.infer<typeof envSchema>): Pick<AppConfig["auth"], "github" | "secretKey" | "allowedUsers"> {
  const configError = (message: string) => new AppError(ErrorCode.CONFIG_INVALID, message);

  let secretKey: Buffer | null = null;
  if (parsed.SHIPYARD_SECRET_KEY !== undefined) {
    secretKey = parseSecretKey(parsed.SHIPYARD_SECRET_KEY);
    // Never echo the value: it is a secret.
    if (!secretKey) throw configError("SHIPYARD_SECRET_KEY must be 32 bytes, base64 (`openssl rand -base64 32`).");
  }

  const allowedRaw = parsed.SHIPYARD_ALLOWED_GITHUB_USERS?.trim();
  const allowedUsers: readonly string[] | "*" =
    allowedRaw === "*"
      ? "*"
      : (allowedRaw ?? "").split(",").map((login) => login.trim().toLowerCase()).filter(Boolean);

  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = parsed;
  if (clientId === undefined && clientSecret === undefined) return { github: null, secretKey, allowedUsers };
  if (clientId === undefined || clientSecret === undefined) {
    throw configError("Set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or neither.");
  }
  if (!secretKey) {
    throw configError("GitHub sign-in needs SHIPYARD_SECRET_KEY to encrypt stored tokens (`openssl rand -base64 32`).");
  }
  // Anyone who signs in can run code on this host: who may sign in must be an explicit decision.
  if (allowedUsers !== "*" && allowedUsers.length === 0) {
    throw configError(
      'GitHub sign-in needs SHIPYARD_ALLOWED_GITHUB_USERS: your GitHub login(s), comma-separated, or "*" for any GitHub account.',
    );
  }
  return { github: { clientId, clientSecret }, secretKey, allowedUsers };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
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
