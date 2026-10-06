import Docker from "dockerode";

import { loadConfig, requireDatabaseUrl } from "../config/env.js";
import { createPrismaClient } from "../db/prisma.js";
import { createLogger } from "../lib/logger.js";
import { BackupService } from "./BackupService.js";

/**
 *   npm run backup  -- <dir>                 everything this machine holds
 *   npm run backup  -- verify <dir>          checksums only
 *   npm run restore -- <dir> --yes [--database <name>]
 * See docs/operations.md. Restore is destructive: stop the API first.
 */
const args = process.argv.slice(2);
if (!["backup", "verify", "restore"].includes(args[0] ?? "")) args.unshift("backup");
const [command, dir, ...rest] = args;
const config = loadConfig();
const logger = createLogger({ level: config.logLevel, pretty: true });
const url = new URL(requireDatabaseUrl(config));
const prisma = createPrismaClient(url.toString());
const service = new BackupService({
  docker: new Docker(),
  prisma,
  databaseContainer: process.env.SHIPYARD_DB_CONTAINER ?? "shipyard-postgres",
  databaseName: url.pathname.slice(1),
  databaseUser: decodeURIComponent(url.username),
  logger,
});

const usage = "usage: backup <dir> | verify <dir> | restore <dir> --yes [--database <name>]";
try {
  if (!dir) throw new Error(usage);
  if (command === "backup") {
    const manifest = await service.backup(dir);
    console.log(`Backed up to ${dir}: Shipyard's database, ${manifest.databases.length} database(s), ${manifest.volumes.length} volume(s).`);
    for (const line of manifest.skipped) console.log(`  skipped ${line}`);
    console.log("Copy .env (SHIPYARD_SECRET_KEY) separately, and keep both somewhere safe: the dump holds encrypted secrets.");
  } else if (command === "verify") {
    const problems = await service.verify(dir);
    if (problems.length > 0) throw new Error(`Damaged: ${problems.join("; ")}`);
    console.log("Intact: every file matches its checksum.");
  } else if (command === "restore") {
    if (!rest.includes("--yes")) throw new Error("Restoring replaces Shipyard's data with the backup's. Stop the API, then run again with --yes.");
    const at = rest.indexOf("--database");
    const report = await service.restore(dir, at >= 0 && rest[at + 1] ? { databaseName: rest[at + 1] } : {});
    for (const line of report.restored) console.log(`restored ${line}`);
    for (const line of report.skipped) console.log(`skipped ${line}`);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
