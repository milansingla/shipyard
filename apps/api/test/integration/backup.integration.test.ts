import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/db/prisma.js";
import { BackupService } from "../../src/ops/BackupService.js";
import { createTestPrisma } from "../helpers/db.js";
import { silentLogger } from "../helpers/silentLogger.js";

// A backup only counts once it has been restored: this backs up a project's
// volume and its PostgreSQL service plus Shipyard's own database, damages
// them, restores, and checks everything came back.

const run = promisify(execFile);
const docker = new Docker();
const DB_CONTAINER = "shipyard-postgres";
const RESTORE_DB = "shipyard_restore_check";
const suffix = randomUUID().slice(0, 8);
let prisma: PrismaClient;
let outDir: string;
let volumeName: string;
let dbContainerId: string;

const sh = (container: string, script: string) => run("docker", ["exec", container, "sh", "-c", script]).then((r) => r.stdout.trim());
const psql = (container: string, user: string, db: string, sql: string) => run("docker", ["exec", container, "psql", "-U", user, "-d", db, "-tAc", sql]).then((r) => r.stdout.trim());
const inVolume = (script: string) =>
  run("docker", ["run", "--rm", "-v", `${volumeName}:/data`, "--entrypoint", "sh", "postgres:17-alpine", "-c", script]).then((r) => r.stdout.trim());

beforeAll(async () => {
  prisma = createTestPrisma();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-backup-"));
  const user = await prisma.user.create({ data: { githubId: BigInt(Date.now()), login: `backup-${suffix}`, githubAccessToken: "x" } });
  const org = await prisma.organization.create({ data: { name: `backup-${suffix}`, slug: `backup-${suffix}`, memberships: { create: { userId: user.id, role: "OWNER" } } } });
  const project = await prisma.project.create({
    data: { organizationId: org.id, name: `bk-${suffix}`, slug: `bk-${suffix}`, repositoryUrl: "https://github.com/acme/bk", repositoryOwner: "acme", repositoryName: "bk", branch: "main" },
  });
  const web = await prisma.service.create({ data: { projectId: project.id, name: "web" } });
  const db = await prisma.service.create({ data: { projectId: project.id, name: "db", type: "POSTGRES", image: "postgres:17-alpine", port: 5432, public: false } });
  volumeName = `shipyard-${web.id}-uploads`;
  await prisma.volume.create({ data: { serviceId: web.id, name: "uploads", mountPath: "/app/uploads", dockerName: volumeName } });

  await docker.createVolume({ Name: volumeName, Labels: { "shipyard.managed": "true" } });
  await inVolume("echo hello > /data/a.txt && mkdir /data/sub && echo nested > /data/sub/b.txt");

  // The project's database, as Shipyard would run it.
  const container = await docker.createContainer({
    Image: "postgres:17-alpine",
    name: `shipyard-it-backupdb-${suffix}`,
    Env: ["POSTGRES_USER=app", "POSTGRES_DB=app", "POSTGRES_PASSWORD=pw"],
    Labels: { "shipyard.managed": "true" },
  });
  await container.start();
  dbContainerId = container.id;
  for (let i = 0; i < 60; i += 1) {
    if (await run("docker", ["exec", dbContainerId, "pg_isready", "-h", "127.0.0.1", "-U", "app", "-d", "app"]).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await psql(dbContainerId, "app", "app", "CREATE TABLE orders (id int); INSERT INTO orders VALUES (42);");
  await prisma.deployment.create({ data: { projectId: project.id, serviceId: db.id, branch: "main", status: "RUNNING", containerId: dbContainerId, containerName: "x", finishedAt: new Date() } });
});

afterAll(async () => {
  await docker.getContainer(dbContainerId).remove({ force: true }).catch(() => {});
  await docker.getVolume(volumeName).remove().catch(() => {});
  await sh(DB_CONTAINER, `dropdb -U shipyard --if-exists ${RESTORE_DB}`).catch(() => {});
  await fs.rm(outDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe("backup and restore against real Docker and PostgreSQL", () => {
  const service = () =>
    new BackupService({ docker, prisma, databaseContainer: DB_CONTAINER, databaseName: "shipyard_test", databaseUser: "shipyard", logger: silentLogger });

  it("backs up Shipyard's database, a project database and a volume, with checksums", async () => {
    const manifest = await service().backup(outDir);
    expect(manifest.database).toMatchObject({ name: "shipyard_test", file: "shipyard.dump" });
    expect(manifest.databases).toHaveLength(1);
    expect(manifest.volumes).toMatchObject([{ dockerName: volumeName, name: "uploads", mountPath: "/app/uploads" }]);
    for (const entry of [manifest.database, ...manifest.databases, ...manifest.volumes]) expect(entry.bytes).toBeGreaterThan(0);
    expect(await service().verify(outDir)).toEqual([]);
  });

  it("restores them: the data comes back exactly", async () => {
    // Damage everything.
    await inVolume("rm -rf /data/* && echo wrong > /data/c.txt");
    await psql(dbContainerId, "app", "app", "DROP TABLE orders;");
    await sh(DB_CONTAINER, `dropdb -U shipyard --if-exists ${RESTORE_DB} && createdb -U shipyard ${RESTORE_DB}`);

    const report = await service().restore(outDir, { databaseName: RESTORE_DB });
    expect(report.skipped).toEqual([]);
    expect(report.restored).toHaveLength(3);

    expect(await inVolume("cat /data/a.txt /data/sub/b.txt; ls /data")).toBe("hello\nnested\na.txt\nsub");
    expect(await psql(dbContainerId, "app", "app", "SELECT id FROM orders")).toBe("42");
    const original = await psql(DB_CONTAINER, "shipyard", "shipyard_test", "SELECT count(*) FROM projects");
    expect(await psql(DB_CONTAINER, "shipyard", RESTORE_DB, "SELECT count(*) FROM projects")).toBe(original);
    expect(await psql(DB_CONTAINER, "shipyard", RESTORE_DB, `SELECT slug FROM projects WHERE slug = 'bk-${suffix}'`)).toBe(`bk-${suffix}`);
  });

  it("refuses a damaged backup", async () => {
    await fs.appendFile(path.join(outDir, "shipyard.dump"), "x");
    expect(await service().verify(outDir)).toEqual(["shipyard.dump: checksum mismatch"]);
    await expect(service().restore(outDir, { databaseName: RESTORE_DB })).rejects.toThrow("The backup is damaged");
  });
});
