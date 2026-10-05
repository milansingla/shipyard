/**
 * Shipyard CLI — V0.1 command parity on top of the V2 engine.
 *
 *   npm run shipyard -- deploy <repo-url> [--branch <name>]
 *   npm run shipyard -- logs <container-name> [--tail <n>]
 *   npm run shipyard -- stop <container-name>
 *   npm run shipyard -- restart <container-name>
 */
import { parseArgs } from "node:util";

import { createServices } from "./bootstrap.js";
import { loadConfig } from "./config/env.js";
import { AppError, ValidationError, errorMessage } from "./lib/errors.js";
import { createLogger } from "./lib/logger.js";
import { DeploymentFailedError } from "./services/deployment/DeploymentService.js";
import type { DeploymentObserver } from "./services/deployment/types.js";
import { formatLogChunks } from "./services/docker/logs.js";

const USAGE = `
Shipyard V2 (CLI)

Usage:
  npm run shipyard -- deploy <repo-url> [--branch <name>]
  npm run shipyard -- logs <container-name> [--tail <n>]
  npm run shipyard -- stop <container-name>
  npm run shipyard -- restart <container-name>
`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      branch: { type: "string", short: "b" },
      tail: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, target] = positionals;

  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (!target) {
    throw new ValidationError(`Missing argument for "${command}".\n${USAGE}`);
  }

  const config = loadConfig();
  // The CLI prints its own progress and outcome, so service logs default to errors only.
  const logger = createLogger({
    level: config.logLevelExplicit ? config.logLevel : "error",
    pretty: config.env !== "production",
  });
  const { deployments } = createServices(config, logger);

  switch (command) {
    case "deploy": {
      const observer: DeploymentObserver = {
        onStatusChange: (record) => console.log(`\n▶ ${record.status}`),
        onLog: (source, text) => process.stdout.write(source === "runtime" ? `[app] ${text}` : text),
      };
      const record = await deployments.deploy(
        { repositoryUrl: target, ...(values.branch !== undefined && { branch: values.branch }) },
        observer,
      );
      console.log(`\n✅ Deployed ${record.repositoryOwner}/${record.repositoryName} → ${record.deploymentUrl}`);
      console.log(`   container: ${record.containerName}\n`);
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    case "logs": {
      const tail = values.tail === undefined ? undefined : Number.parseInt(values.tail, 10);
      if (tail !== undefined && (!Number.isInteger(tail) || tail <= 0)) {
        throw new ValidationError("--tail must be a positive integer.");
      }
      process.stdout.write(formatLogChunks(await deployments.getLogs(target, tail)));
      return;
    }
    case "stop":
      console.log(JSON.stringify(await deployments.stop(target), null, 2));
      return;
    case "restart":
      console.log(JSON.stringify(await deployments.restart(target), null, 2));
      return;
    default:
      throw new ValidationError(`Unknown command "${command}".\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof DeploymentFailedError) {
    console.error(`\n❌ Deployment ${error.deployment.id} FAILED (${error.code})`);
    console.error(`   ${error.message}`);
    if (error.deployment.containerName && error.deployment.containerId) {
      console.error(`   Inspect: npm run shipyard -- logs ${error.deployment.containerName}`);
    }
  } else if (error instanceof AppError) {
    console.error(`\n❌ ${error.code}: ${error.message}`);
  } else {
    console.error("\n❌ Unexpected error:", error instanceof Error ? (error.stack ?? errorMessage(error)) : error);
  }
  process.exitCode = 1;
});
