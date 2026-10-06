import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { AppError, ErrorCode } from "../lib/errors.js";
import { parseSecretKey } from "../lib/secretBox.js";

// Resolves to <repo root>/.env from both src/config and dist/config.
const ROOT_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

// One or more DNS labels: "localhost", "apps.example.com". No scheme, port or wildcard.
const DOMAIN = /^(?=.{1,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

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
  // Only two sensible values. With Traefik routing, only loopback (health checks) is allowed.
  SHIPYARD_PUBLISH_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  SHIPYARD_HEALTHCHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  SHIPYARD_GIT_CLONE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  SHIPYARD_BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),
  /** Serve each project at <slug>.<domain> through Traefik. Unset = each deployment on its own port. */
  SHIPYARD_PUBLIC_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DOMAIN, 'must be a domain name such as "localhost" or "apps.example.com" (no scheme or port)')
    .optional(),
  /** Port Traefik listens on, on this host (docker-compose.yml publishes it). */
  SHIPYARD_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(80),
  /** Contact for Let's Encrypt. Set = serve apps over HTTPS (docker-compose.production.yml). */
  SHIPYARD_ACME_EMAIL: z.email().optional(),
  SHIPYARD_HTTPS_PORT: z.coerce.number().int().min(1).max(65535).default(443),
  /** Push deployment images here, e.g. ghcr.io/acme or localhost:5000/shipyard. Unset = keep them in local Docker. */
  SHIPYARD_REGISTRY: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/,
      "must be a registry and optional path, like ghcr.io/acme or localhost:5000/shipyard (no scheme, tag or trailing /)",
    )
    .optional(),
  SHIPYARD_REGISTRY_USERNAME: z.string().min(1).optional(),
  SHIPYARD_REGISTRY_PASSWORD: z.string().min(1).optional(),
  /** Proxies whose X-Forwarded-For is believed (Express "trust proxy" syntax), e.g. "127.0.0.1". Unset = none. */
  SHIPYARD_TRUST_PROXY: z.string().trim().min(1).optional(),
  /** Lets worker machines register; long and random (`openssl rand -hex 32`). Unset = only the built-in worker. */
  SHIPYARD_WORKER_JOIN_TOKEN: z.string().min(32, "must be at least 32 characters (`openssl rand -hex 32`)").optional(),
  /** GitHub logins that administer the platform itself (workers), comma-separated. */
  SHIPYARD_ADMINS: z.string().optional(),
  /** This process's worker name (default: the hostname). */
  SHIPYARD_WORKER_NAME: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "must be a lowercase DNS label, up to 40 characters")
    .optional(),
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
  /** null = no proxy: each deployment is reached on its own published port. */
  routing: {
    domain: string;
    /** Where Traefik listens on this host. */
    httpPort: number;
    /** Traefik's dynamic configuration directory (mounted by docker-compose.yml). */
    routesDir: string;
    /** HTTPS via Let's Encrypt; null = plain HTTP. */
    tls: { email: string; httpsPort: number } | null;
  } | null;
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
  /** Express "trust proxy"; false = X-Forwarded-For is ignored. */
  trustProxy: string | false;
  /** null = images stay in local Docker. */
  registry: { prefix: string; credentials: { username: string; password: string } | null } | null;
  workers: {
    /** null = no other machine may register as a worker. */
    joinToken: string | null;
    /** Lower-cased GitHub logins of platform administrators. */
    admins: readonly string[];
    /** This machine's worker name. */
    name: string;
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

  const dataDir = path.resolve(parsed.SHIPYARD_DATA_DIR ?? path.join(os.homedir(), ".shipyard"));
  const routing = parsed.SHIPYARD_PUBLIC_DOMAIN
    ? {
        domain: parsed.SHIPYARD_PUBLIC_DOMAIN,
        httpPort: parsed.SHIPYARD_HTTP_PORT,
        routesDir: path.join(dataDir, "traefik"),
        tls: parsed.SHIPYARD_ACME_EMAIL ? { email: parsed.SHIPYARD_ACME_EMAIL, httpsPort: parsed.SHIPYARD_HTTPS_PORT } : null,
      }
    : null;
  if (parsed.SHIPYARD_ACME_EMAIL && !routing) {
    throw new AppError(ErrorCode.CONFIG_INVALID, "SHIPYARD_ACME_EMAIL needs SHIPYARD_PUBLIC_DOMAIN: HTTPS is served by Traefik.");
  }
  if (routing && parsed.SHIPYARD_PUBLISH_HOST !== "127.0.0.1") {
    // Visitors come in through Traefik; a port published on every interface would bypass it.
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      "With SHIPYARD_PUBLIC_DOMAIN set, apps are reached through Traefik: SHIPYARD_PUBLISH_HOST must be 127.0.0.1.",
    );
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
    dataDir,
    allowedGitHosts,
    publishHost: parsed.SHIPYARD_PUBLISH_HOST,
    gitCloneTimeoutMs: parsed.SHIPYARD_GIT_CLONE_TIMEOUT_MS,
    buildTimeoutMs: parsed.SHIPYARD_BUILD_TIMEOUT_MS,
    routing,
    healthCheck: {
      timeoutMs: parsed.SHIPYARD_HEALTHCHECK_TIMEOUT_MS,
      intervalMs: 1_000,
      requestTimeoutMs: 3_000,
    },
    publicUrl,
    appUrl: trimTrailingSlash(parsed.SHIPYARD_APP_URL ?? publicUrl),
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET ?? null,
    trustProxy: parsed.SHIPYARD_TRUST_PROXY ?? false,
    registry: parseRegistry(parsed),
    workers: {
      joinToken: parsed.SHIPYARD_WORKER_JOIN_TOKEN ?? null,
      admins: (parsed.SHIPYARD_ADMINS ?? "").split(",").map((login) => login.trim().toLowerCase()).filter(Boolean),
      name: parsed.SHIPYARD_WORKER_NAME ?? workerNameFromHost(os.hostname()),
    },
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

function parseRegistry(parsed: z.infer<typeof envSchema>): AppConfig["registry"] {
  const { SHIPYARD_REGISTRY: prefix, SHIPYARD_REGISTRY_USERNAME: username, SHIPYARD_REGISTRY_PASSWORD: password } = parsed;
  if ((username === undefined) !== (password === undefined)) {
    throw new AppError(ErrorCode.CONFIG_INVALID, "Set both SHIPYARD_REGISTRY_USERNAME and SHIPYARD_REGISTRY_PASSWORD, or neither.");
  }
  if (!prefix) {
    if (username) throw new AppError(ErrorCode.CONFIG_INVALID, "Registry credentials are set but SHIPYARD_REGISTRY isn't.");
    return null;
  }
  return { prefix, credentials: username && password ? { username, password } : null };
}

/** The hostname as a DNS label ("Milans-MacBook.local" → "milans-macbook-local"). */
export function workerNameFromHost(hostname: string): string {
  const label = hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return label || "worker";
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
