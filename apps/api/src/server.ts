import { createApp } from "./app.js";
import { createServices } from "./bootstrap.js";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./lib/logger.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, pretty: config.env === "development" });
const services = createServices(config, logger);

const app = createApp({
  docker: services.docker,
  logger: logger.child({ component: "http" }),
  exposeInternalErrors: config.env !== "production",
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, `Shipyard API listening on http://localhost:${config.port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "Shutting down");
  server.close((error) => {
    if (error) logger.error({ err: error }, "Error while closing HTTP server");
    process.exit(error ? 1 : 0);
  });
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
