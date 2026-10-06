import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import { DeploymentEngine, DeploymentFailedError } from "../../src/services/deployment/DeploymentEngine.js";
import { HealthCheckService } from "../../src/services/deployment/HealthCheckService.js";
import { DeploymentStatus as S } from "../../src/services/deployment/status.js";
import type { DeploymentJob, DeploymentState } from "../../src/services/deployment/types.js";
import { DockerService } from "../../src/services/docker/DockerService.js";
import { formatLogChunks } from "../../src/services/docker/logs.js";
import { serviceSpec } from "../../src/modules/services/serviceRules.js";
import { POSTGRES_DATA_PATH } from "../../src/modules/services/postgres.js";
import type { Service } from "../../src/db/prisma.js";
import type { SourceProvider } from "../../src/services/git/GitService.js";
import { parseRepositoryUrl } from "../../src/services/git/repositoryUrl.js";
import { DirectPortRouter } from "../../src/services/routing/Router.js";
import { LocalRegistry, RemoteRegistry } from "../../src/services/registry/ImageRegistry.js";
import { WorkspaceService } from "../../src/services/workspace/WorkspaceService.js";
import { silentLogger } from "../helpers/silentLogger.js";

// Real Docker daemon, real build, real container, real HTTP health check.
// Only `git clone` is replaced: the "repository" is copied from a local
// directory so the test doesn't depend on GitHub. (Cloning itself is covered
// by git.integration.test.ts.)

const here = path.dirname(fileURLToPath(import.meta.url));
const HELLO_APP = path.resolve(here, "../../../../examples/hello-node");
const CRASHING_APP = path.resolve(here, "../fixtures/crashing-app");
const NODE_NO_DOCKERFILE_APP = path.resolve(here, "../fixtures/node-no-dockerfile");
const HEALTH_PORT_APP = path.resolve(here, "../fixtures/health-port-app");
const MEMORY_HOG_APP = path.resolve(here, "../fixtures/memory-hog");
const VOLUME_APP = path.resolve(here, "../fixtures/volume-app");
const MULTI_SERVICE_APP = path.resolve(here, "../fixtures/multi-service");
const DETECT = path.resolve(here, "../fixtures/detect");

function localSource(sourceDir: string): SourceProvider {
  return {
    async clone(_repo, destination) {
      await fs.cp(sourceDir, destination, { recursive: true });
      return { path: destination, commitSha: "0".repeat(40) };
    },
  };
}

const dockerode = new Docker();
const docker = new DockerService(dockerode, { publishHost: "127.0.0.1", buildTimeoutMs: 300_000 }, silentLogger);
const created: DeploymentState[] = [];
let workspaceRoot: string;

function engine(sourceDir: string): DeploymentEngine {
  return new DeploymentEngine({
    source: localSource(sourceDir),
    docker,
    healthCheck: new HealthCheckService({ timeoutMs: 30_000, intervalMs: 500, requestTimeoutMs: 2_000 }),
    workspace: new WorkspaceService(workspaceRoot),
    router: new DirectPortRouter(), // Traefik routing: routing.integration.test.ts
    registry: new LocalRegistry(),
    logger: silentLogger,
  });
}

function job(name: string, extra: Pick<DeploymentJob, "env" | "healthCheck" | "resources"> = {}): DeploymentJob {
  return {
    id: randomUUID(),
    repository: parseRepositoryUrl(`https://github.com/shipyard-test/${name}`, ["github.com"]),
    branch: null,
    name,
    ...extra,
  };
}

beforeAll(async () => {
  if (!(await docker.ping())) {
    throw new Error("Docker daemon is not reachable — start Docker Desktop before running integration tests.");
  }
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-it-"));
});

afterAll(async () => {
  for (const record of created) {
    if (record.containerId) await docker.removeContainer(record.containerId);
    await docker.removeImage(record.imageName);
  }
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe("deployment engine against real Docker", () => {
  it("deploys, serves traffic, logs, restarts and stops a Node app", async () => {
    const service = engine(HELLO_APP);
    const statuses: string[] = [];
    let buildOutput = "";

    const record = await service.run(job("hello-node"), {
        onStatusChange: (r) => void statuses.push(r.status),
        onLog: (source, text) => {
          if (source === "build") buildOutput += text;
        },
    });
    created.push(record);

    expect(statuses).toEqual([
      S.CLONING,
      S.DETECTING,
      S.BUILDING,
      S.STARTING,
      S.HEALTH_CHECKING,
      S.HEALTHY,
      S.ROUTING,
      S.RUNNING,
    ]);
    expect(buildOutput).toContain("FROM node:24-alpine");
    expect(record.containerPort).toBe(3000);

    // It actually serves traffic at the reported URL.
    const response = await fetch(record.deploymentUrl!.replace("localhost", "127.0.0.1"));
    expect(await response.text()).toContain("Hello from Shipyard");

    // Logs are decoded (no binary multiplexing headers).
    const logs = formatLogChunks(await service.getLogs(record.containerName));
    expect(logs).toBe("Server running on port 3000\n");

    // Published only on loopback.
    const info = await dockerode.getContainer(record.containerId!).inspect();
    expect(info.HostConfig.PortBindings?.["3000/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");

    // Follow the output live; the stream ends by itself when the container stops.
    let followed = "";
    const following = service.followLogs(record.containerName, 10, (chunk) => void (followed += chunk.text), new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(followed).toBe("Server running on port 3000\n");
    await docker.stopContainer(record.containerId!);
    await following;

    const restarted = await service.restart(record.containerName, { name: "hello-node" });
    expect(restarted.status).toBe(S.RUNNING);
    expect(restarted.deploymentUrl).toMatch(/^http:\/\/localhost:\d+$/);

    const stopped = await service.stop(record.containerName);
    expect(stopped.status).toBe(S.STOPPED);
    expect((await docker.getContainerState(record.containerId!)).running).toBe(false);

    // Stopping twice is harmless.
    expect((await service.stop(record.containerName)).status).toBe(S.STOPPED);
  });

  it("marks a crashing app FAILED, with its output and exit code", async () => {
    const service = engine(CRASHING_APP);
    const runtimeLogs: string[] = [];

    const error = (await service
      .run(job("crashing-app"), { onLog: (source, text) => void (source === "runtime" && runtimeLogs.push(text)) })
      .catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error).toBeInstanceOf(DeploymentFailedError);
    created.push(error.deployment);

    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(error.deployment.status).toBe(S.FAILED);
    expect(error.deployment.failedStage).toBe(S.HEALTH_CHECKING);
    expect(error.message).toContain("exited with code 1");
    expect(runtimeLogs.join("")).toContain("fatal: missing DATABASE_URL");
  });

  it("generates a Dockerfile for a Node app without one, honouring .dockerignore and variables", async () => {
    const service = engine(NODE_NO_DOCKERFILE_APP);
    let systemLog = "";
    const env = {
      runtime: { GREETING: "ahoy", API_TOKEN: "tok-secret-123" },
      build: { BUILD_LABEL: "v42" },
    };

    const record = await service.run(job("node-no-dockerfile", { env }), {
      onLog: (source, text) => void (source === "system" && (systemLog += text)),
    });
    created.push(record);

    expect(record.status).toBe(S.RUNNING);
    expect(systemLog).toContain("detected a Node.js project (npm, Node 24)");

    const response = await fetch(record.deploymentUrl!.replace("localhost", "127.0.0.1"));
    expect(await response.json()).toEqual({
      built: "built during docker build (v42)", // `npm run build` ran, and saw the build variable
      secretInImage: false, // .dockerignore was applied to the build context
      user: "node", // not root
      nodeEnv: "production",
      greeting: "ahoy", // runtime variable reached the app
    });

    // Runtime variables live in the container's config, never in the image.
    const container = await dockerode.getContainer(record.containerId!).inspect();
    expect(container.Config.Env).toEqual(expect.arrayContaining(["API_TOKEN=tok-secret-123", "PORT=3000"]));
    const image = JSON.stringify(await dockerode.getImage(record.imageName).history());
    expect(image).not.toContain("tok-secret-123");
    // Build variables DO end up in the image history — why secrets can't be build variables.
    expect(image).toContain("BUILD_LABEL=v42");
    expect(systemLog).not.toContain("tok-secret-123");
  });

  it("refuses to operate on containers Shipyard did not create", async () => {
    const service = engine(HELLO_APP);
    const foreign = await dockerode.createContainer({ Image: "node:24-alpine", name: `not-shipyard-${Date.now()}` });
    try {
      await expect(service.stop(foreign.id)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    } finally {
      await foreign.remove({ force: true });
    }
  });

  it("health-checks a separate admin port and path, published on loopback only, the same way after a restart", async () => {
    const service = engine(HEALTH_PORT_APP);
    const record = await service.run(job("health-port-app", { healthCheck: { path: "/healthz", port: 9000, timeoutMs: 20_000 } }));
    created.push(record);
    expect(record.status).toBe(S.RUNNING);

    const info = await dockerode.getContainer(record.containerId!).inspect();
    expect(info.HostConfig.PortBindings?.["9000/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(info.Config.Labels).toMatchObject({ "shipyard.health-path": "/healthz", "shipyard.health-port": "9000" });

    // Restart reads the settings back from the container's labels.
    expect((await service.restart(record.containerName, { name: "health-port-app" })).status).toBe(S.RUNNING);
    await service.stop(record.containerName);
  });

  it("fails a deployment whose health path answers 404, saying to check the path", async () => {
    const error = (await engine(HEALTH_PORT_APP)
      .run(job("health-port-app", { healthCheck: { path: "/wrong", port: 9000, timeoutMs: 3_000 } }))
      .catch((e: unknown) => e)) as DeploymentFailedError;
    created.push(error.deployment);

    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(error.deployment.failedStage).toBe(S.HEALTH_CHECKING);
    expect(error.message).toMatch(/HTTP 404.*health check path/s);
  });

  it("applies CPU, memory and restart policy to the container", async () => {
    const record = await engine(HELLO_APP).run(
      job("hello-node", { resources: { cpuLimit: 0.5, memoryLimitMb: 128, restartPolicy: "UNLESS_STOPPED" } }),
    );
    created.push(record);

    const { HostConfig } = await dockerode.getContainer(record.containerId!).inspect();
    expect(HostConfig).toMatchObject({
      NanoCpus: 500_000_000,
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      RestartPolicy: { Name: "unless-stopped" },
    });
    await docker.stopContainer(record.containerId!);
  });

  it("still fails fast when a crashing app is being restarted by its restart policy", async () => {
    const startedAt = Date.now();
    const error = (await engine(CRASHING_APP)
      .run(job("crashing-app", { resources: { cpuLimit: null, memoryLimitMb: null, restartPolicy: "UNLESS_STOPPED" } }))
      .catch((e: unknown) => e)) as DeploymentFailedError;
    created.push(error.deployment);

    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(error.message).toContain("exited with code 1");
    expect(Date.now() - startedAt).toBeLessThan(25_000); // not the 30s health timeout
    // Stopped by Shipyard, so Docker's restart policy no longer brings it back.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await docker.getContainerState(error.deployment.containerId!)).running).toBe(false);
  });

  it("explains an app killed for exceeding its memory limit", async () => {
    const error = (await engine(MEMORY_HOG_APP)
      .run(job("memory-hog", { resources: { cpuLimit: null, memoryLimitMb: 64, restartPolicy: "NO" } }))
      .catch((e: unknown) => e)) as DeploymentFailedError;
    created.push(error.deployment);

    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(error.message).toContain("ran out of memory");
  });

  it("reuses the cached dependency install when only the source changed, and still ships the new source", async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-cache-"));
    try {
      await fs.cp(NODE_NO_DOCKERFILE_APP, source, { recursive: true });
      const build = async () => {
        let output = "";
        const record = await engine(source).run(job("cache-app"), { onLog: (kind, text) => void (kind === "build" && (output += text)) });
        created.push(record);
        await docker.stopContainer(record.containerId!);
        return { record, output };
      };
      await build();
      // A source-only change: the manifests are untouched.
      await fs.writeFile(path.join(source, "build.js"), 'require("node:fs").writeFileSync("built.txt", "second build");\n');
      const second = await build();

      // The step right after `RUN npm ci` comes from the cache…
      expect(second.output).toMatch(/RUN npm ci\s*\n\s*---> Using cache/);
      // …but the source after it doesn't: the change made it into the image.
      expect(second.output).not.toMatch(/COPY --chown=node:node \. \.\s*\n\s*---> Using cache/);
      await docker.restartContainer(second.record.containerId!);
      const info = await docker.inspectManagedContainer(second.record.containerId!);
      let body: Record<string, unknown> = {};
      for (let i = 0; i < 20 && body.built !== "second build"; i += 1) {
        body = await fetch(`http://127.0.0.1:${info.hostPort}/`).then((r) => r.json() as Promise<Record<string, unknown>>, () => ({}));
        if (body.built !== "second build") await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(body.built).toBe("second build");
    } finally {
      await fs.rm(source, { recursive: true, force: true });
    }
  });

  it("pushes the image to a real registry when one is configured", async () => {
    const port = 15_000 + Math.floor(Math.random() * 5_000);
    const image = "registry:2";
    if (!(await dockerode.getImage(image).inspect().then(() => true, () => false))) {
      await new Promise((resolve, reject) =>
        dockerode.pull(image, (error: unknown, stream: NodeJS.ReadableStream) =>
          error ? reject(error) : dockerode.modem.followProgress(stream, (e) => (e ? reject(e) : resolve(null))),
        ),
      );
    }
    const registryContainer = await dockerode.createContainer({
      Image: image,
      name: `shipyard-it-registry-${port}`,
      HostConfig: { PortBindings: { "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } },
      ExposedPorts: { "5000/tcp": {} },
    });
    await registryContainer.start();
    try {
      // localhost registries are the one kind Docker allows over plain HTTP.
      const registry = new RemoteRegistry(`localhost:${port}/shipyard-it`, null, docker);
      const service = new DeploymentEngine({
        source: localSource(HELLO_APP),
        docker,
        healthCheck: new HealthCheckService({ timeoutMs: 30_000, intervalMs: 500, requestTimeoutMs: 2_000 }),
        workspace: new WorkspaceService(workspaceRoot),
        router: new DirectPortRouter(),
        registry,
        logger: silentLogger,
      });
      let buildLog = "";
      const record = await service.run(job("hello-node"), { onLog: (kind, text) => void (kind === "build" && (buildLog += text)) });
      created.push(record);

      expect(record.imageName).toMatch(new RegExp(`^localhost:${port}/shipyard-it/hello-node:[0-9a-f]{12}$`));
      expect(buildLog).toContain(`Pushed ${record.imageName}`);
      const tags = (await (await fetch(`http://127.0.0.1:${port}/v2/shipyard-it/hello-node/tags/list`)).json()) as { tags: string[] };
      expect(tags.tags).toEqual([record.imageName.split(":").at(-1)]);
    } finally {
      await registryContainer.remove({ force: true });
    }
  });

  it("keeps a volume's data across deployments, writable by a non-root app, and deletes it only when asked", async () => {
    const volumeName = `shipyard-it-${randomUUID()}-data`;
    const volumes = [{ name: volumeName, mountPath: "/data" }];
    const service = engine(VOLUME_APP);
    const visit = async (record: DeploymentState) =>
      (await fetch(record.deploymentUrl!.replace("localhost", "127.0.0.1"))).json() as Promise<{ boots: number; uid: number }>;
    try {
      let log = "";
      const first = await service.run({ ...job("volume-app"), volumes }, { onLog: (_source, text) => void (log += text) });
      created.push(first);
      expect(await visit(first)).toEqual({ boots: 1, uid: 1000 }); // the image's "node" user wrote to the new volume
      expect(log).toContain(`Created volume ${volumeName} at /data`);
      await docker.removeContainer(first.containerId!);

      const second = await service.run({ ...job("volume-app"), volumes });
      created.push(second);
      expect(await visit(second)).toEqual({ boots: 2, uid: 1000 }); // a new container, the same data
      await docker.removeContainer(second.containerId!);

      // Never someone else's volume, even by name; Shipyard's own only when asked.
      const foreign = `shipyard-it-foreign-${randomUUID().slice(0, 8)}`;
      await dockerode.createVolume({ Name: foreign });
      await service.removeVolumes([foreign]);
      expect(await dockerode.getVolume(foreign).inspect()).toMatchObject({ Name: foreign });
      await dockerode.getVolume(foreign).remove();

      await service.removeVolumes([volumeName, volumeName]); // idempotent
      await expect(dockerode.getVolume(volumeName).inspect()).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await dockerode.getVolume(volumeName).remove().catch(() => {});
    }
  });

  it("runs PostgreSQL from the official image: private, ready when pg_isready passes, data kept across a stop-first redeploy", async () => {
    const projectId = randomUUID();
    const serviceId = randomUUID();
    const volumeName = `shipyard-${serviceId}-data`;
    const password = randomUUID();
    const spec = serviceSpec({ id: projectId }, { id: serviceId, name: "db", type: "POSTGRES", image: "postgres:17-alpine", port: 5432 } as Service);
    const dbJob = (): DeploymentJob => ({
      ...job("pg"),
      service: spec,
      volumes: [{ name: volumeName, mountPath: POSTGRES_DATA_PATH }],
      env: { runtime: { POSTGRES_PASSWORD: password }, build: {} },
    });
    // psql inside the container, connecting over TCP to the service's name on the project network.
    const psql = async (containerId: string, sql: string) =>
      (
        await promisify(execFile)("docker", ["exec", "-e", `PGPASSWORD=${password}`, containerId, "psql", "-h", "db", "-U", "app", "-d", "app", "-tAc", sql])
      ).stdout.trim();
    const service = engine(HELLO_APP); // the source is never cloned for a prebuilt image
    try {
      let log = "";
      const first = await service.run(dbJob(), { onLog: (_source, text) => void (log += text) });
      created.push(first);
      expect(first).toMatchObject({ status: S.RUNNING, imageName: "postgres:17-alpine", containerPort: 5432, hostPort: null });
      expect(log).toContain("nothing to clone or build");
      expect(log).toContain("Ready: pg_isready succeeded");
      expect(log).not.toContain(password);
      const info = await dockerode.getContainer(first.containerId!).inspect();
      expect(info.NetworkSettings.Ports ?? {}).toEqual({ "5432/tcp": null }); // exposed by the image, published nowhere
      expect(info.NetworkSettings.Networks[spec.network]?.Aliases).toContain("db");
      await psql(first.containerId!, "CREATE TABLE orders (id int); INSERT INTO orders VALUES (42);");

      // What DeploymentService does for a database: stop the old server, then start the new one.
      await service.stop(first.containerId!);
      const second = await service.run(dbJob());
      created.push(second);
      expect(await psql(second.containerId!, "SELECT id FROM orders")).toBe("42");

      // Cleaning up never deletes a prebuilt image other projects may use.
      await docker.removeImage("postgres:17-alpine");
      expect(await dockerode.getImage("postgres:17-alpine").inspect()).toMatchObject({ RepoTags: expect.arrayContaining(["postgres:17-alpine"]) });
    } finally {
      for (const record of created.splice(-2)) if (record.containerId) await docker.removeContainer(record.containerId);
      await dockerode.getVolume(volumeName).remove().catch(() => {});
      await docker.removeNetwork(spec.network);
    }
  });

  it("samples a running container's CPU, memory and restarts", async () => {
    const record = await engine(HELLO_APP).run(job("hello-node"));
    created.push(record);
    try {
      const [sample] = await engine(HELLO_APP).stats(record.containerId!);
      expect(sample).toMatchObject({ running: true, restartCount: 0, memoryLimitMb: null });
      expect(sample!.memoryMb).toBeGreaterThan(1);
      expect(sample!.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(Date.parse(sample!.startedAt!)).toBeLessThanOrEqual(Date.now());
    } finally {
      await docker.removeContainer(record.containerId!);
    }
  });

  it("runs a one-off command to completion (a cron run): exit code, output, timeout, nothing left behind", async () => {
    const network = `shipyard-p-it${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await docker.ensureNetwork(network, {});
    const run = (name: string, command: string[], timeoutMs = 30_000) =>
      docker.runToCompletion({
        imageName: "node:24-alpine",
        containerName: `shipyard-it-cron-${name}-${randomUUID().slice(0, 8)}`,
        command,
        env: { GREETING: "hello" },
        labels: {},
        network,
        timeoutMs,
      });
    try {
      const failed = await run("fail", ["sh", "-c", "echo $GREETING; echo oops >&2; exit 3"]);
      expect(failed).toMatchObject({ exitCode: 3, timedOut: false });
      expect(failed.output).toContain("hello");
      expect(failed.output).toContain("oops");

      const started = Date.now();
      const slow = await run("slow", ["sleep", "60"], 1_500);
      expect(slow).toMatchObject({ exitCode: null, timedOut: true });
      expect(Date.now() - started).toBeLessThan(15_000);

      const left = await dockerode.listContainers({ all: true, filters: { name: ["shipyard-it-cron-"] } });
      expect(left).toEqual([]);
    } finally {
      await docker.removeNetwork(network);
    }
  });

  it("runs a multi-service project: web reaches the private api by name, the worker just runs", async () => {
    const network = `shipyard-p-it${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const service = engine(MULTI_SERVICE_APP);
    const spec = (alias: string, overrides: object) => ({
      type: "WEB" as const,
      sourceDir: alias,
      buildCommand: null,
      startCommand: null,
      port: null,
      public: true,
      network,
      alias,
      ...overrides,
    });
    const run = async (alias: string, overrides: object) => {
      const record = await service.run({ ...job(`multi-${alias}`), service: spec(alias, overrides) });
      created.push(record);
      return record;
    };
    try {
      const api = await run("api", { port: 4000, public: false });
      const worker = await run("worker", { type: "WORKER", public: false });
      const web = await run("web", {});

      expect(worker).toMatchObject({ status: S.RUNNING, containerPort: null, hostPort: null });
      expect(api.deploymentUrl).toBeNull(); // private: no address outside the project
      const body = await (await fetch(web.deploymentUrl!.replace("localhost", "127.0.0.1"))).json();
      expect(body).toEqual({ from: "web", api: { from: "api" } });

      // The api isn't published beyond loopback, and only the project network knows it as "api".
      const info = await dockerode.getContainer(api.containerId!).inspect();
      expect(info.NetworkSettings.Networks[network]?.Aliases).toContain("api");
    } finally {
      for (const record of created.splice(-3)) {
        if (record.containerId) await docker.removeContainer(record.containerId);
        await docker.removeImage(record.imageName);
      }
      await docker.removeNetwork(network);
    }
  });
});


// Repositories without a Dockerfile, in different languages: detected, a
// Dockerfile generated, built for real, started, health-checked and served.
describe("repository detection against real Docker", () => {
  it.each([
    ["monorepo-npm", "Node.js", "hello from the monorepo", "Service:         apps/web"],
    ["fastapi", "Python", '{"hello":"fastapi"}', "Framework:       FastAPI"],
    ["flask", "Python", "hello from flask", "Framework:       Flask"],
    ["go", "Go", "hello from go", "Language:        Go"],
    ["php", "PHP", "hello from php", "Language:        PHP"],
    ["static", "HTML", "hello from static", "Language:        HTML"],
    ["vite", "Node.js", '<div id="app"></div>', "Framework:       Vite"],
    ["pnpm", "Node.js", "hello from pnpm (1m)", "pnpm-lock.yaml (lockfileVersion 9.0) → pnpm 9"],
    ["pnpm-workspace", "Node.js", "hello from the pnpm workspace, web (built with pnpm/9.15.0, node 22)", "Service:         apps/web"],
  ])("%s: detected as %s, built and serving", async (fixture, language, body, logLine) => {
    let systemLog = "";
    const record = await engine(path.join(DETECT, fixture)).run(job(`detect-${fixture}`), {
      onLog: (source, text) => void (source === "system" && (systemLog += text)),
    });
    created.push(record);

    expect(record.status).toBe(S.RUNNING);
    expect(systemLog).toContain(`Language:        ${language}`);
    expect(systemLog).toContain(logLine);
    expect(systemLog).toContain("Dockerfile:      generated");
    const base = record.deploymentUrl!.replace("localhost", "127.0.0.1");
    const response = await fetch(base);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(body);
    if (fixture === "static") expect((await fetch(`${base}/.secrets`)).status).toBe(404);
  });
});

describe("dependency install failures against real Docker", () => {
  it("an outdated pnpm lockfile: still a frozen install (never relaxed), and the failure says why", async () => {
    let log = "";
    const error = (await engine(path.join(DETECT, "pnpm-stale"))
      .run(job("detect-pnpm-stale"), { onLog: (_source, text) => void (log += text) })
      .catch((e: unknown) => e)) as DeploymentFailedError;
    created.push(error.deployment);

    expect(error).toBeInstanceOf(DeploymentFailedError);
    expect(error.code).toBe(ErrorCode.DOCKER_BUILD_FAILED);
    expect(error.deployment.failedStage).toBe(S.BUILDING);
    // Warned during detection, before Docker ran.
    expect(log).toContain("note: pnpm-lock.yaml is out of date with package.json");
    expect(error.message).toContain("Dependency installation failed: the lockfile is out of date with package.json.");
    expect(error.message).toMatch(/Package manager: pnpm 9\.\d+\.\d+ \(pnpm-lock\.yaml \(lockfileVersion 9\.0\) → pnpm 9\)/);
    expect(error.message).toContain("Command: pnpm install --frozen-lockfile");
    expect(error.message).toContain("  - left-pad@1.3.0 is in package.json but not in the lockfile");
    expect(error.message).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
  });
});
