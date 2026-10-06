import os from "node:os";

import { createEngineServices } from "./bootstrap.js";
import { loadConfig } from "./config/env.js";
import { AppError, ErrorCode } from "./lib/errors.js";
import { createLogger } from "./lib/logger.js";
import { SHIPYARD_VERSION } from "./version.js";
import { runWorkerAgent } from "./worker/agent.js";

/**
 * A Shipyard worker: `npm run worker` on a machine with Docker. Needs
 * SHIPYARD_CONTROL_PLANE_URL (the API's URL), SHIPYARD_WORKER_JOIN_TOKEN, and
 * SHIPYARD_WORKER_ADDRESS (where Traefik reaches this machine's published
 * ports; then SHIPYARD_PUBLISH_HOST=0.0.0.0). See docs/workers.md.
 */
const config = loadConfig();
const logger = createLogger({ level: config.logLevel, pretty: config.env === "development" });
const controlPlaneUrl = process.env.SHIPYARD_CONTROL_PLANE_URL;
if (!controlPlaneUrl || !config.workers.joinToken) {
  throw new AppError(ErrorCode.CONFIG_INVALID, "A worker needs SHIPYARD_CONTROL_PLANE_URL and SHIPYARD_WORKER_JOIN_TOKEN.");
}
const address = process.env.SHIPYARD_WORKER_ADDRESS?.trim() || undefined;
if (address && config.publishHost !== "0.0.0.0") {
  logger.warn("SHIPYARD_WORKER_ADDRESS is set but SHIPYARD_PUBLISH_HOST isn't 0.0.0.0: Traefik won't reach this machine's apps.");
}

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown.abort());

await runWorkerAgent({
  controlPlaneUrl,
  joinToken: config.workers.joinToken,
  info: {
    name: config.workers.name,
    hostname: os.hostname(),
    cpus: os.availableParallelism(),
    memoryMb: Math.round(os.totalmem() / 1024 / 1024),
    version: SHIPYARD_VERSION,
    ...(address && { address }),
  },
  createEngine: (router) => {
    const { engine, docker } = createEngineServices(config, logger, router);
    return Object.assign(engine, { runToCompletion: docker.runToCompletion.bind(docker) });
  },
  logger,
  signal: shutdown.signal,
});
