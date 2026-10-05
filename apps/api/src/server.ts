import { createApp } from "./app.js";
import { createApiServices } from "./bootstrap.js";
import { loadConfig, requireDatabaseUrl } from "./config/env.js";
import { createLogger } from "./lib/logger.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, pretty: config.env === "development" });
const services = createApiServices(config, requireDatabaseUrl(config), logger);

// Fail fast if the database is unreachable, then repair statuses left behind
// by a previous run (e.g. a deploy that was BUILDING when the process died).
await services.prisma.$connect();
await services.deployments.reconcileOnStartup();
await services.auth?.service.deleteExpiredSessions();
await services.webhooks?.service.pruneDeliveries();
if (!services.auth) {
  logger.warn("GitHub sign-in is not configured: project and deployment endpoints will answer 503. See .env.example.");
}

const app = createApp({
  docker: services.docker,
  projects: services.projects,
  deployments: services.deployments,
  environment: services.environment,
  domains: services.domains,
  audit: services.audit,
  organizations: services.organizations,
  auth: services.auth,
  webhooks: services.webhooks,
  allowedOrigins: [config.publicUrl, config.appUrl],
  logger: logger.child({ component: "http" }),
  exposeInternalErrors: config.env !== "production",
  trustProxy: config.trustProxy,
});

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, env: config.env }, `Shipyard API listening on http://${config.host}:${config.port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "Shutting down");
  // In-flight deploys are not awaited (a build can take minutes); they are
  // marked FAILED by reconcileOnStartup() on the next start.
  server.close((error) => {
    if (error) logger.error({ err: error }, "Error while closing HTTP server");
    void services.prisma.$disconnect().finally(() => process.exit(error ? 1 : 0));
  });
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
