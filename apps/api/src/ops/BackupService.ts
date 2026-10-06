import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type Docker from "dockerode";

import type { PrismaClient } from "../db/prisma.js";
import { AppError, ErrorCode } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { POSTGRES_DB, POSTGRES_USER } from "../modules/services/postgres.js";
import { ShipyardLabel } from "../services/docker/DockerService.js";
import { SHIPYARD_VERSION } from "../version.js";

export const MANIFEST = "manifest.json";

export interface BackupManifest {
  format: 1;
  createdAt: string;
  shipyardVersion: string;
  /** Shipyard's own database: projects, deployments, variables (encrypted), history. */
  database: BackupFile & { name: string };
  /** Projects' PostgreSQL services, as logical dumps. */
  databases: Array<BackupFile & { serviceId: string; project: string; service: string }>;
  /** Persistent volumes (not databases'), as tar.gz. */
  volumes: Array<BackupFile & { dockerName: string; project: string; service: string; name: string; mountPath: string }>;
  /** What couldn't be backed up from this machine, and why. */
  skipped: string[];
}

interface BackupFile {
  file: string;
  sha256: string;
  bytes: number;
}

export interface BackupServiceDeps {
  docker: Docker;
  prisma: PrismaClient;
  /** The container running Shipyard's PostgreSQL (docker-compose: shipyard-postgres). */
  databaseContainer: string;
  /** From DATABASE_URL. */
  databaseName: string;
  databaseUser: string;
  logger: Logger;
}

/**
 * Backups of everything Shipyard can't rebuild from Git:
 *
 * - its own database (pg_dump inside its container): projects, settings,
 *   encrypted variables, deployment history, audit log;
 * - each project's PostgreSQL service (pg_dump inside the running database:
 *   a file copy of a live database can be inconsistent);
 * - every other persistent volume (tar.gz through a helper container).
 *
 * Everything streams through Docker (exec and attach), so nothing needs
 * host paths or bind mounts. A manifest lists every file with its sha256.
 * Configuration (.env) is NOT included: copy it yourself, kept secret, since
 * without SHIPYARD_SECRET_KEY the variables in the dump can't be decrypted.
 */
export class BackupService {
  constructor(private readonly deps: BackupServiceDeps) {}

  async backup(outDir: string): Promise<BackupManifest> {
    const { prisma, logger } = this.deps;
    await fs.mkdir(outDir, { recursive: true });
    const skipped: string[] = [];

    logger.info({ outDir }, "Backing up Shipyard's database");
    const database = {
      name: this.deps.databaseName,
      ...(await this.execToFile(this.deps.databaseContainer, ["pg_dump", "-Fc", "-U", this.deps.databaseUser, "-d", this.deps.databaseName], path.join(outDir, "shipyard.dump"))),
    };

    const databases: BackupManifest["databases"] = [];
    const postgresServices = await prisma.service.findMany({ where: { type: "POSTGRES" }, include: { project: { select: { slug: true } } } });
    for (const service of postgresServices) {
      const live = await prisma.deployment.findFirst({
        where: { serviceId: service.id, environmentId: null, status: "RUNNING", containerId: { not: null } },
        orderBy: { finishedAt: "desc" },
      });
      const label = `${service.project.slug}/${service.name}`;
      if (!live?.containerId || !(await this.exists(live.containerId))) {
        skipped.push(`database ${label}: not running on this machine (back it up where it runs, or deploy it first)`);
        continue;
      }
      const file = await this.execToFile(live.containerId, ["pg_dump", "-Fc", "-U", POSTGRES_USER, "-d", POSTGRES_DB], path.join(outDir, `db-${service.id}.dump`));
      databases.push({ ...file, serviceId: service.id, project: service.project.slug, service: service.name });
    }

    const volumes: BackupManifest["volumes"] = [];
    const rows = await prisma.volume.findMany({ include: { service: { include: { project: { select: { slug: true } } } } } });
    for (const volume of rows) {
      const label = `${volume.service.project.slug}/${volume.service.name}/${volume.name}`;
      if (volume.service.type === "POSTGRES") continue; // dumped above, consistently
      if (!(await this.volumeExists(volume.dockerName))) {
        skipped.push(`volume ${label}: not on this machine (it lives on the worker that ran it)`);
        continue;
      }
      const file = await this.volumeToFile(volume.dockerName, path.join(outDir, `volume-${volume.id}.tar.gz`));
      volumes.push({
        ...file,
        dockerName: volume.dockerName,
        project: volume.service.project.slug,
        service: volume.service.name,
        name: volume.name,
        mountPath: volume.mountPath,
      });
    }

    const manifest: BackupManifest = { format: 1, createdAt: new Date().toISOString(), shipyardVersion: SHIPYARD_VERSION, database, databases, volumes, skipped };
    await fs.writeFile(path.join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    logger.info({ outDir, databases: databases.length, volumes: volumes.length, skipped: skipped.length }, "Backup written");
    return manifest;
  }

  /** Checks every file against the manifest's checksums. Returns the problems (empty = intact). */
  async verify(dir: string): Promise<string[]> {
    const manifest = await this.manifest(dir);
    const problems: string[] = [];
    for (const entry of [manifest.database, ...manifest.databases, ...manifest.volumes]) {
      const actual = await sha256(path.join(dir, entry.file)).catch(() => null);
      if (actual !== entry.sha256) problems.push(`${entry.file}: ${actual === null ? "missing" : "checksum mismatch"}`);
    }
    return problems;
  }

  /**
   * Restores a backup over the current state. Destructive: Shipyard's tables,
   * each database service's contents and each volume's files are replaced.
   * Stop the API first. `databaseName` restores Shipyard's database into
   * another (existing, empty) database instead, e.g. to test a backup.
   */
  async restore(dir: string, options: { databaseName?: string } = {}): Promise<{ restored: string[]; skipped: string[] }> {
    const problems = await this.verify(dir);
    if (problems.length > 0) throw new AppError(ErrorCode.VALIDATION_ERROR, `The backup is damaged: ${problems.join("; ")}`);
    const manifest = await this.manifest(dir);
    const restored: string[] = [];
    const skipped: string[] = [];
    const target = options.databaseName ?? manifest.database.name;

    await this.execFromFile(
      this.deps.databaseContainer,
      ["pg_restore", "--clean", "--if-exists", "--no-owner", "-U", this.deps.databaseUser, "-d", target],
      path.join(dir, manifest.database.file),
    );
    restored.push(`Shipyard's database → ${target}`);

    for (const entry of manifest.databases) {
      const live = await this.deps.prisma.deployment.findFirst({
        where: { serviceId: entry.serviceId, environmentId: null, status: "RUNNING", containerId: { not: null } },
        orderBy: { finishedAt: "desc" },
      });
      if (!live?.containerId || !(await this.exists(live.containerId))) {
        skipped.push(`database ${entry.project}/${entry.service}: deploy it, then restore again`);
        continue;
      }
      await this.execFromFile(live.containerId, ["pg_restore", "--clean", "--if-exists", "--no-owner", "-U", POSTGRES_USER, "-d", POSTGRES_DB], path.join(dir, entry.file));
      restored.push(`database ${entry.project}/${entry.service}`);
    }

    for (const entry of manifest.volumes) {
      await this.fileToVolume(path.join(dir, entry.file), entry.dockerName);
      restored.push(`volume ${entry.project}/${entry.service}/${entry.name}`);
    }
    return { restored, skipped };
  }

  // ───────────── Docker plumbing ─────────────

  private async manifest(dir: string): Promise<BackupManifest> {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), "utf8")) as BackupManifest;
    if (manifest.format !== 1) throw new AppError(ErrorCode.VALIDATION_ERROR, `Unknown backup format: ${manifest.format}`);
    // File names come from the manifest: they must stay inside the backup directory.
    for (const entry of [manifest.database, ...manifest.databases, ...manifest.volumes]) {
      if (!/^[A-Za-z0-9._-]+$/.test(entry.file)) throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid file name in the manifest: ${entry.file}`);
    }
    return manifest;
  }

  /** Runs a command in a container and writes its stdout to `file`. Fails on a non-zero exit. */
  private async execToFile(containerId: string, cmd: string[], file: string): Promise<BackupFile> {
    const exec = await this.deps.docker.getContainer(containerId).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = createWriteStream(file);
    const stderr = collect();
    this.deps.docker.modem.demuxStream(stream, stdout, stderr.sink);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    await new Promise<void>((resolve) => stdout.end(resolve));
    await this.assertExit(exec, cmd, stderr.text());
    return { file: path.basename(file), sha256: await sha256(file), bytes: (await fs.stat(file)).size };
  }

  /** Runs a command in a container with `file` as its stdin. Fails on a non-zero exit. */
  private async execFromFile(containerId: string, cmd: string[], file: string): Promise<void> {
    const exec = await this.deps.docker.getContainer(containerId).exec({ Cmd: cmd, AttachStdin: true, AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: true });
    const stderr = collect();
    this.deps.docker.modem.demuxStream(stream, new PassThrough().resume(), stderr.sink);
    const finished = new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });
    await pipeline(createReadStream(file), new Writable({
      write(chunk, _encoding, callback) {
        stream.write(chunk, callback);
      },
      final(callback) {
        (stream as unknown as { end(): void }).end();
        callback();
      },
    }));
    await finished;
    await this.assertExit(exec, cmd, stderr.text());
  }

  private async assertExit(exec: Docker.Exec, cmd: string[], stderr: string): Promise<void> {
    let info = await exec.inspect();
    for (let i = 0; i < 50 && info.Running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      info = await exec.inspect();
    }
    if (info.ExitCode !== 0) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, `${cmd[0]} exited ${info.ExitCode}: ${stderr.trim().slice(-500)}`);
    }
  }

  /** tar.gz of a volume, streamed out of a short-lived container that mounts it read-only. */
  private async volumeToFile(volume: string, file: string): Promise<BackupFile> {
    await this.runHelper(volume, true, ["tar", "-C", "/data", "-czf", "-", "."], { output: file });
    return { file: path.basename(file), sha256: await sha256(file), bytes: (await fs.stat(file)).size };
  }

  /** Replaces a volume's files with the archive's (creating the volume if needed). */
  private async fileToVolume(file: string, volume: string): Promise<void> {
    if (!(await this.volumeExists(volume))) {
      await this.deps.docker.createVolume({ Name: volume, Labels: { [ShipyardLabel.MANAGED]: "true" } });
    }
    await this.runHelper(volume, false, ["sh", "-c", "find /data -mindepth 1 -delete && tar -C /data -xzf -"], { input: file });
  }

  private async runHelper(volume: string, readOnly: boolean, cmd: string[], io: { output?: string; input?: string }): Promise<void> {
    const { docker } = this.deps;
    const image = (await docker.getContainer(this.deps.databaseContainer).inspect()).Config.Image; // postgres:…-alpine has sh and tar
    const container = await docker.createContainer({
      Image: image,
      Entrypoint: cmd.slice(0, 1),
      Cmd: cmd.slice(1),
      User: "0",
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: Boolean(io.input),
      OpenStdin: Boolean(io.input),
      StdinOnce: Boolean(io.input),
      HostConfig: { Mounts: [{ Type: "volume", Source: volume, Target: "/data", ReadOnly: readOnly }], NetworkMode: "none" },
      Labels: { "shipyard.backup-helper": "true" },
    });
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true, stdin: Boolean(io.input), hijack: true });
      const stderr = collect();
      const out = io.output ? createWriteStream(io.output) : new PassThrough().resume();
      docker.modem.demuxStream(stream, out, stderr.sink);
      const ended = new Promise<void>((resolve) => stream.on("end", resolve));
      await container.start();
      if (io.input) {
        await pipeline(createReadStream(io.input), new Writable({
          write(chunk, _encoding, callback) {
            stream.write(chunk, callback);
          },
          final(callback) {
            (stream as unknown as { end(): void }).end();
            callback();
          },
        }));
      }
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (io.output) await new Promise<void>((resolve) => (out as ReturnType<typeof createWriteStream>).end(resolve));
      if (StatusCode !== 0) throw new AppError(ErrorCode.INTERNAL_ERROR, `${cmd.join(" ")} exited ${StatusCode}: ${stderr.text().trim().slice(-500)}`);
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  private async exists(containerId: string): Promise<boolean> {
    return this.deps.docker.getContainer(containerId).inspect().then((info) => info.State.Running, () => false);
  }

  private async volumeExists(name: string): Promise<boolean> {
    return this.deps.docker.getVolume(name).inspect().then(() => true, () => false);
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function collect() {
  const chunks: Buffer[] = [];
  return {
    sink: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (chunks.length < 64) chunks.push(chunk);
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}
