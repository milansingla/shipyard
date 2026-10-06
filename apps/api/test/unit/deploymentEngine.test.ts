import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError, ErrorCode } from "../../src/lib/errors.js";
import {
  DeploymentEngine,
  type DeploymentEngineDeps,
  DeploymentFailedError,
  type EngineDocker,
} from "../../src/services/deployment/DeploymentEngine.js";
import { DeploymentStatus as S } from "../../src/services/deployment/status.js";
import type { DeploymentStatus } from "../../src/services/deployment/status.js";
import type { DeploymentJob, DeploymentObserver } from "../../src/services/deployment/types.js";
import type { SourceProvider } from "../../src/services/git/GitService.js";
import { parseRepositoryUrl } from "../../src/services/git/repositoryUrl.js";
import { type ImageRegistry, LocalRegistry, RemoteRegistry } from "../../src/services/registry/ImageRegistry.js";
import type { Router } from "../../src/services/routing/Router.js";
import { WorkspaceService } from "../../src/services/workspace/WorkspaceService.js";
import { silentLogger } from "../helpers/silentLogger.js";

// Orchestration tests: fake git + Docker so we can assert ordering, status
// transitions and failure handling deterministically. The real Docker path
// is covered by test/integration/deployment.integration.test.ts.

const COMMIT = "a".repeat(40);
const JOB_ID = "3f2a9c1e-77b4-4d0e-9a11-5c6d7e8f9012";

function job(overrides: Partial<DeploymentJob> = {}): DeploymentJob {
  return {
    id: JOB_ID,
    repository: parseRepositoryUrl("https://github.com/octocat/hello", ["github.com"]),
    branch: "main",
    name: "hello",
    ...overrides,
  };
}

interface Harness {
  engine: DeploymentEngine;
  calls: string[];
  statuses: DeploymentStatus[];
  observer: DeploymentObserver;
  workspaceRoot: string;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-engine-"));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function harness(
  options: {
    dockerfile?: string | null;
    files?: Record<string, string>;
    buildFails?: boolean;
    /** true = every health check fails; a number = only the Nth one (1-based). */
    healthFails?: boolean | number;
    /** Behave like the Traefik router (own network, hostname URLs) instead of plain ports. */
    routed?: boolean;
    routeFails?: boolean;
    registry?: ImageRegistry;
    /** What Docker's own health check reports (prebuilt images). */
    dockerHealth?: "healthy" | "unhealthy";
  } = {},
): Harness {
  const calls: string[] = [];
  const statuses: DeploymentStatus[] = [];
  let healthChecks = 0;
  const workspaceRoot = path.join(tmpRoot, "ws");

  const source: SourceProvider = {
    async clone(_repo, destination, branch) {
      calls.push(`clone:${branch ?? "default"}`);
      await fs.mkdir(destination, { recursive: true });
      const dockerfile = options.dockerfile === undefined ? "FROM node\nEXPOSE 8080\n" : options.dockerfile;
      if (dockerfile !== null) await fs.writeFile(path.join(destination, "Dockerfile"), dockerfile);
      for (const [name, contents] of Object.entries(options.files ?? {})) {
        await fs.writeFile(path.join(destination, name), contents);
      }
      return { path: destination, commitSha: COMMIT };
    },
  };

  const unused = async (): Promise<never> => {
    throw new Error("not used in this test");
  };

  const docker: EngineDocker = {
    async buildImage(
      ctx: string,
      imageName: string,
      labels: Record<string, string>,
      _onLog,
      dockerfile = "Dockerfile",
      buildArgs: Record<string, string> = {},
    ) {
      if (Object.keys(buildArgs).length > 0) calls.push(`buildArgs:${JSON.stringify(buildArgs)}`);
      if (labels["shipyard.health-path"] !== "/") calls.push(`labels:${JSON.stringify(labels)}`);
      calls.push(`build:${imageName}:${labels["shipyard.container-port"]}:${labels["shipyard.project-id"]}`);
      calls.push(`dockerfile:${dockerfile}:${await fs.readFile(path.join(ctx, dockerfile), "utf8").then(() => "present", () => "missing")}`);
      if (options.buildFails) {
        throw new AppError(ErrorCode.DOCKER_BUILD_FAILED, "Docker build failed: npm ci exited 1");
      }
    },
    async createAndStartContainer(opts) {
      calls.push(`start:${opts.containerName}:${opts.containerPort}:${opts.network ?? "bridge"}`);
      if (opts.privateNetwork) calls.push(`private:${opts.privateNetwork.name}=${opts.privateNetwork.alias}`);
      if (opts.command) calls.push(`command:${JSON.stringify(opts.command)}`);
      if (opts.env && Object.keys(opts.env).length > 0) calls.push(`env:${JSON.stringify(opts.env)}`);
      if (opts.healthCheckPort) calls.push(`healthPort:${opts.healthCheckPort}`);
      if (opts.resources) calls.push(`resources:${JSON.stringify(opts.resources)}`);
      if (opts.healthCommand) calls.push(`healthCommand:${opts.healthCommand.join(" ")}`);
      if (opts.labels["shipyard.health-kind"]) calls.push(`healthKind:${opts.labels["shipyard.health-kind"]}`);
      if (opts.volumes?.length) calls.push(`mounts:${opts.volumes.map((v) => `${v.name}=${v.mountPath}`).join(",")}`);
      const replica = Number(opts.labels["shipyard.replica"] ?? 1);
      const id = replica === 1 ? "container-id" : `container-id-r${replica}`;
      if (opts.containerPort === null) return { id, hostPort: null, healthHostPort: null };
      return { id, hostPort: 49153, healthHostPort: opts.healthCheckPort ? 49154 : 49153 };
    },
    async getContainerState() {
      return { running: true, exitCode: null, oomKilled: false, health: options.dockerHealth ?? "healthy" };
    },
    deploymentContainers: unused,
    containerStats: unused,
    async ensureImage(name: string) {
      calls.push(`pull:${name}`);
    },
    async getLogs() {
      calls.push("logs");
      return [{ stream: "stderr" as const, text: "Error: listen EADDRINUSE\n" }];
    },
    async stopContainer(id: string) {
      calls.push(`stop:${id}`);
    },
    inspectManagedContainer: unused,
    restartContainer: unused,
    followLogs: unused,
    async ensureNetwork(name: string) {
      calls.push(`network:${name}`);
    },
    removeNetwork: unused,
    async ensureVolume(name: string) {
      calls.push(`volume:${name}`);
      return true;
    },
    async prepareVolumeOwnership(name: string, _image: string, mountPath: string) {
      calls.push(`chown:${name}:${mountPath}`);
    },
    removeVolume: unused,
    connectToNetwork: unused,
    removeContainer: unused,
    removeImage: unused,
  };

  const router: Router = {
    network: options.routed ? "shipyard-edge" : null,
    urlFor: (name, hostPort) => (options.routed ? `http://${name}.localhost` : `http://localhost:${hostPort}`),
    async activate(target) {
      calls.push(`route:${target.name}->${target.containerName}:${target.containerPort}`);
      if (target.replicaContainers?.length) calls.push(`replicas:${target.replicaContainers.join(",")}`);
      if (target.healthCheck) calls.push(`lbHealth:${target.healthCheck.path}:${target.healthCheck.port}`);
      if (options.routeFails) {
        throw new AppError(ErrorCode.ROUTING_FAILED, "Traefik did not start sending hello.localhost to this deployment.");
      }
    },
    async deactivate() {},
    async sync() {},
  };

  const engine = new DeploymentEngine({
    source,
    docker,
    healthCheck: {
      async waitUntilHealthy({ url, strict, timeoutMs }) {
        calls.push(`health:${url}`);
        if (strict || timeoutMs) calls.push(`healthRule:${strict ? "strict" : "lenient"}:${timeoutMs ?? "default"}`);
        healthChecks += 1;
        if (options.healthFails === true || options.healthFails === healthChecks) {
          throw new AppError(ErrorCode.HEALTH_CHECK_FAILED, "Container exited with code 1 before becoming healthy.");
        }
        return { statusCode: 200, attempts: 1, durationMs: 5 };
      },
    },
    workspace: new WorkspaceService(workspaceRoot),
    router,
    registry: options.registry ?? new LocalRegistry(),
    workerSettleMs: 30,
    logger: silentLogger,
  });

  return {
    engine,
    calls,
    statuses,
    observer: { onStatusChange: (state) => void statuses.push(state.status) },
    workspaceRoot,
  };
}

async function workspaceEntries(root: string): Promise<string[]> {
  return fs.readdir(root).catch(() => []);
}

describe("DeploymentEngine.run", () => {
  it("runs the full pipeline and ends RUNNING", async () => {
    const h = harness();
    const state = await h.engine.run(job({ labels: { "shipyard.project-id": "p1" } }), h.observer);

    expect(h.statuses).toEqual([S.CLONING, S.DETECTING, S.BUILDING, S.STARTING, S.HEALTH_CHECKING, S.HEALTHY, S.ROUTING, S.RUNNING]);
    expect(h.calls).toEqual([
      "clone:main",
      "build:shipyard/hello:3f2a9c1e77b4:8080:p1",
      "dockerfile:Dockerfile:present",
      "start:shipyard-hello-3f2a9c1e77b4:8080:bridge",
      "health:http://127.0.0.1:49153/",
      "route:hello->shipyard-hello-3f2a9c1e77b4:8080",
    ]);
    expect(state).toMatchObject({
      id: JOB_ID,
      status: S.RUNNING,
      branch: "main",
      commitSha: COMMIT,
      imageName: "shipyard/hello:3f2a9c1e77b4",
      containerName: "shipyard-hello-3f2a9c1e77b4",
      containerId: "container-id",
      containerPort: 8080,
      hostPort: 49153,
      deploymentUrl: "http://localhost:49153",
      errorMessage: null,
      failedStage: null,
    });
    expect(state.startedAt).toBeInstanceOf(Date);
    expect(state.finishedAt).toBeInstanceOf(Date);
    // Clone is deleted once the image is built.
    expect(await workspaceEntries(h.workspaceRoot)).toEqual([]);
  });

  it("awaits async observers so persisted statuses stay in order", async () => {
    const h = harness();
    const order: string[] = [];
    await h.engine.run(job(), {
      onStatusChange: async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(state.status);
      },
    });
    expect(order).toEqual([S.CLONING, S.DETECTING, S.BUILDING, S.STARTING, S.HEALTH_CHECKING, S.HEALTHY, S.ROUTING, S.RUNNING]);
  });

  it("defaults to port 3000 and the default branch", async () => {
    const h = harness({ dockerfile: "FROM node\nCMD node index.js\n" });
    const state = await h.engine.run(job({ branch: null }), h.observer);
    expect(state.containerPort).toBe(3000);
    expect(state.branch).toBeNull();
    expect(h.calls[0]).toBe("clone:default");
  });

  it("generates a Dockerfile for a Node project without one, builds with it, and cleans up", async () => {
    const h = harness({ dockerfile: null, files: { "package.json": JSON.stringify({ scripts: { start: "node ." } }) } });
    let systemLog = "";
    const state = await h.engine.run(job(), {
      ...h.observer,
      onLog: (source, text) => void (source === "system" && (systemLog += text)),
    });

    expect(state.status).toBe(S.RUNNING);
    expect(state.containerPort).toBe(3000);
    expect(h.calls).toContain("dockerfile:.shipyard.Dockerfile:present");
    expect(systemLog).toContain("Generated Dockerfile:");
    expect(await workspaceEntries(h.workspaceRoot)).toEqual([]);
  });

  it("fails with PROJECT_DETECTION_FAILED for a Node project it cannot start", async () => {
    const h = harness({ dockerfile: null, files: { "package.json": "{}" } });
    const error = (await h.engine.run(job(), h.observer).catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error.code).toBe(ErrorCode.PROJECT_DETECTION_FAILED);
    expect(h.statuses).toEqual([S.CLONING, S.DETECTING, S.FAILED]);
    expect(error.deployment.failedStage).toBe(S.DETECTING);
  });

  it("fails with DOCKERFILE_NOT_FOUND and cleans up the clone", async () => {
    const h = harness({ dockerfile: null });
    const error = await h.engine.run(job(), h.observer).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeploymentFailedError);
    expect((error as DeploymentFailedError).code).toBe(ErrorCode.DOCKERFILE_NOT_FOUND);
    expect((error as DeploymentFailedError).deployment.status).toBe(S.FAILED);
    expect(h.statuses).toEqual([S.CLONING, S.DETECTING, S.FAILED]);
    expect(await workspaceEntries(h.workspaceRoot)).toEqual([]);
  });

  it("records build failures and never starts a container", async () => {
    const h = harness({ buildFails: true });
    const error = (await h.engine.run(job(), h.observer).catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error.code).toBe(ErrorCode.DOCKER_BUILD_FAILED);
    expect(error.deployment.errorMessage).toContain("npm ci exited 1");
    expect(h.statuses).toEqual([S.CLONING, S.DETECTING, S.BUILDING, S.FAILED]);
    expect(error.deployment.failedStage).toBe(S.BUILDING);
    expect(h.calls.some((c) => c.startsWith("start:"))).toBe(false);
    expect(await workspaceEntries(h.workspaceRoot)).toEqual([]);
  });

  it("on health-check failure: collects runtime logs, stops the container, ends FAILED", async () => {
    const h = harness({ healthFails: true });
    const logs: string[] = [];
    const error = (await h.engine
      .run(job(), { ...h.observer, onLog: (source, text) => void (source === "runtime" && logs.push(text)) })
      .catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(h.statuses).toEqual([S.CLONING, S.DETECTING, S.BUILDING, S.STARTING, S.HEALTH_CHECKING, S.FAILED]);
    expect(error.deployment.failedStage).toBe(S.HEALTH_CHECKING);
    expect(h.calls.slice(-2)).toEqual(["logs", "stop:container-id"]);
    expect(logs).toEqual(["Error: listen EADDRINUSE\n"]);
    expect(error.deployment).toMatchObject({ containerId: "container-id", deploymentUrl: null });
  });

  it("with a proxy: joins its network and moves the hostname only once the app is healthy", async () => {
    const h = harness({ routed: true });
    const state = await h.engine.run(job(), { onStatusChange: (record) => void h.calls.push(record.status) });

    expect(h.calls).toContain("start:shipyard-hello-3f2a9c1e77b4:8080:shipyard-edge");
    expect(h.calls.slice(-5)).toEqual([
      "health:http://127.0.0.1:49153/",
      S.HEALTHY,
      S.ROUTING,
      "route:hello->shipyard-hello-3f2a9c1e77b4:8080",
      S.RUNNING,
    ]);
    expect(state.deploymentUrl).toBe("http://hello.localhost");
  });

  it("when traffic can't be moved: FAILED, container stopped, so the previous deployment keeps serving", async () => {
    const h = harness({ routed: true, routeFails: true });
    const error = (await h.engine.run(job(), h.observer).catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error.code).toBe(ErrorCode.ROUTING_FAILED);
    expect(h.statuses).toEqual([S.CLONING, S.DETECTING, S.BUILDING, S.STARTING, S.HEALTH_CHECKING, S.HEALTHY, S.ROUTING, S.FAILED]);
    expect(error.deployment.failedStage).toBe(S.ROUTING);
    expect(h.calls.at(-1)).toBe("stop:container-id");
    expect(error.deployment.deploymentUrl).toBeNull();
  });

  it("passes runtime variables to the container and build variables to the build, logging only names", async () => {
    const h = harness({ dockerfile: null, files: { "package.json": JSON.stringify({ scripts: { start: "node ." } }) } });
    let systemLog = "";
    await h.engine.run(
      job({ env: { runtime: { DATABASE_URL: "postgres://secret" }, build: { API_URL: "https://api" } } }),
      { onLog: (source, text) => void (source === "system" && (systemLog += text)) },
    );

    expect(h.calls).toContain('buildArgs:{"API_URL":"https://api"}');
    expect(h.calls).toContain('env:{"DATABASE_URL":"postgres://secret"}');
    expect(systemLog).toContain("ARG API_URL"); // declared in the generated Dockerfile
    expect(systemLog).toContain("Environment: runtime DATABASE_URL; build API_URL");
    expect(systemLog).not.toContain("postgres://secret");
    expect(systemLog).not.toContain("https://api");
  });

  it("health-checks the configured path and port, strictly, and records the settings on the container", async () => {
    const h = harness();
    const state = await h.engine.run(job({ healthCheck: { path: "/healthz?deep=1", port: 9000, timeoutMs: 5_000 } }));
    const labels = JSON.parse(h.calls.find((c) => c.startsWith("labels:"))!.slice("labels:".length)) as Record<string, string>;

    expect(state.status).toBe(S.RUNNING);
    expect(h.calls).toContain("healthPort:9000");
    expect(h.calls).toContain("health:http://127.0.0.1:49154/healthz?deep=1");
    expect(h.calls).toContain("healthRule:strict:5000");
    expect(labels).toMatchObject({
      "shipyard.health-path": "/healthz?deep=1",
      "shipyard.health-port": "9000",
      "shipyard.health-timeout-ms": "5000",
    });
  });

  it.each(["//evil.example/", "http://evil.example/"])("never lets a health path change the host (%s)", async (path) => {
    const h = harness();
    const error = (await h.engine
      .run(job({ healthCheck: { path, port: null, timeoutMs: null } }), h.observer)
      .catch((e: unknown) => e)) as DeploymentFailedError;
    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(h.calls.some((c) => c.startsWith("health:"))).toBe(false);
  });

  it("applies the project's resource limits and says so in the log", async () => {
    const h = harness();
    let systemLog = "";
    const resources = { cpuLimit: 0.5, memoryLimitMb: 512, restartPolicy: "UNLESS_STOPPED" as const };
    await h.engine.run(job({ resources }), { onLog: (source, text) => void (source === "system" && (systemLog += text)) });

    expect(h.calls).toContain(`resources:${JSON.stringify(resources)}`);
    expect(systemLog).toContain("Resources: 0.5 CPU, 512 MB memory, always restarted");
  });

  it("creates each volume before the container, hands a new one to the app's user, and mounts it", async () => {
    const h = harness();
    let systemLog = "";
    await h.engine.run(job({ volumes: [{ name: "shipyard-s-uploads", mountPath: "/app/uploads" }] }), {
      onLog: (source, text) => void (source === "system" && (systemLog += text)),
    });

    const volume = h.calls.indexOf("volume:shipyard-s-uploads");
    expect(h.calls[volume + 1]).toBe("chown:shipyard-s-uploads:/app/uploads");
    expect(h.calls.findIndex((call) => call.startsWith("start:"))).toBeGreaterThan(volume);
    expect(h.calls).toContain("mounts:shipyard-s-uploads=/app/uploads");
    expect(systemLog).toContain("Created volume shipyard-s-uploads at /app/uploads");
  });

  it("names images after the registry and pushes them after the build, before starting", async () => {
    const pushes: string[] = [];
    const registry = new RemoteRegistry("ghcr.io/acme", { username: "bot", password: "s3cret" }, {
      async pushImage(imageName, credentials) {
        pushes.push(`${imageName} as ${credentials?.username}`);
      },
    });
    const h = harness({ registry });
    let buildLog = "";
    const state = await h.engine.run(job(), { onLog: (kind, text) => void (kind === "build" && (buildLog += text)) });

    expect(state.imageName).toBe("ghcr.io/acme/hello:3f2a9c1e77b4");
    expect(pushes).toEqual(["ghcr.io/acme/hello:3f2a9c1e77b4 as bot"]);
    expect(h.calls.findIndex((c) => c.startsWith("build:"))).toBeLessThan(h.calls.findIndex((c) => c.startsWith("start:")));
    expect(buildLog).toContain("Pushed ghcr.io/acme/hello:3f2a9c1e77b4");
    expect(buildLog).not.toContain("s3cret");
  });

  const spec = (overrides: Partial<NonNullable<DeploymentJob["service"]>> = {}) => ({
    type: "WEB" as const,
    sourceDir: ".",
    buildCommand: null,
    startCommand: null,
    port: null,
    public: true,
    network: "shipyard-p-test",
    alias: "api",
    ...overrides,
  });

  it("runs a worker: no port, healthy once it keeps running, never routed", async () => {
    const h = harness({ routed: true });
    const state = await h.engine.run(job({ service: spec({ type: "WORKER", public: false, alias: "jobs" }) }));

    expect(state).toMatchObject({ status: S.RUNNING, containerPort: null, hostPort: null, deploymentUrl: null });
    expect(h.calls).toContain("start:shipyard-hello-3f2a9c1e77b4:null:bridge"); // not on the proxy network
    expect(h.calls).toContain("private:shipyard-p-test=jobs");
    expect(h.calls.some((c) => c.startsWith("health:") || c.startsWith("route:"))).toBe(false);
  });

  it("rolls out replicas one at a time, each health-checked, then routes to all of them", async () => {
    const h = harness({ routed: true });
    const state = await h.engine.run(job({ replicas: 3, healthCheck: { path: "/healthz", port: null, timeoutMs: null } }));

    expect(state).toMatchObject({ status: S.RUNNING, replicas: 3, containerId: "container-id" });
    const order = h.calls.filter((c) => c.startsWith("start:") || c.startsWith("health:") || c.startsWith("route:"));
    expect(order).toEqual([
      "start:shipyard-hello-3f2a9c1e77b4:8080:shipyard-edge",
      "health:http://127.0.0.1:49153/healthz",
      "start:shipyard-hello-3f2a9c1e77b4-r2:8080:shipyard-edge",
      "health:http://127.0.0.1:49153/healthz",
      "start:shipyard-hello-3f2a9c1e77b4-r3:8080:shipyard-edge",
      "health:http://127.0.0.1:49153/healthz",
      "route:hello->shipyard-hello-3f2a9c1e77b4:8080",
    ]);
    expect(h.calls).toContain("replicas:shipyard-hello-3f2a9c1e77b4-r2,shipyard-hello-3f2a9c1e77b4-r3");
    expect(h.calls).toContain("lbHealth:/healthz:null"); // Traefik checks each replica: a configured path
  });

  it("a failing replica stops the rollout: the started ones are stopped and nothing is routed", async () => {
    const h = harness({ routed: true, healthFails: 2 });
    const error = (await h.engine.run(job({ replicas: 3 })).catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error.deployment.failedStage).toBe(S.HEALTH_CHECKING);
    expect(h.calls.filter((c) => c.startsWith("start:"))).toHaveLength(2); // replica 3 never started
    expect(h.calls).toEqual(expect.arrayContaining(["stop:container-id", "stop:container-id-r2"]));
    expect(h.calls.some((c) => c.startsWith("route:"))).toBe(false);
  });

  it("doesn't ask the proxy to check \"/\": many apps answer it with 404", async () => {
    const h = harness({ routed: true });
    await h.engine.run(job({ replicas: 2 }));
    expect(h.calls).toContain("replicas:shipyard-hello-3f2a9c1e77b4-r2");
    expect(h.calls.some((c) => c.startsWith("lbHealth:"))).toBe(false);
  });

  it("runs a prebuilt database image: no clone or build, nothing published, ready when Docker's check passes", async () => {
    const h = harness({ routed: true });
    let systemLog = "";
    const state = await h.engine.run(
      job({
        env: { runtime: { POSTGRES_PASSWORD: "s3cret", POSTGRES_USER: "evil" }, build: {} },
        service: spec({
          type: "POSTGRES",
          alias: "db",
          port: 5432,
          public: false,
          image: { name: "postgres:17-alpine", healthCommand: ["pg_isready", "-h", "127.0.0.1"] },
          environment: { POSTGRES_USER: "app", POSTGRES_DB: "app" },
          stopFirst: true,
        }),
      }),
      { onLog: (source, text) => void (source === "system" && (systemLog += text)) },
    );

    expect(state).toMatchObject({ status: S.RUNNING, imageName: "postgres:17-alpine", containerPort: 5432, hostPort: null, deploymentUrl: null, commitSha: null });
    expect(h.calls.some((c) => c.startsWith("clone:") || c.startsWith("build:"))).toBe(false);
    expect(h.calls).toContain("pull:postgres:17-alpine");
    expect(h.calls).toContain("start:shipyard-hello-3f2a9c1e77b4:null:bridge"); // null: nothing published
    expect(h.calls).toContain("private:shipyard-p-test=db");
    expect(h.calls).toContain("healthCommand:pg_isready -h 127.0.0.1");
    expect(h.calls).toContain("healthKind:docker");
    // Shipyard's own values win over the project's variables.
    expect(h.calls).toContain('env:{"POSTGRES_PASSWORD":"s3cret","POSTGRES_USER":"app","POSTGRES_DB":"app"}');
    expect(h.calls.some((c) => c.startsWith("health:") || c.startsWith("route:"))).toBe(false);
    expect(systemLog).toContain("Ready: pg_isready succeeded");
    expect(systemLog).toContain("reachable inside the project at db:5432");
    expect(systemLog).not.toContain("s3cret");
  });

  it("fails a prebuilt image Docker reports unhealthy", async () => {
    const h = harness({ dockerHealth: "unhealthy" });
    const error = (await h.engine
      .run(job({ service: spec({ type: "POSTGRES", port: 5432, public: false, image: { name: "postgres:17-alpine", healthCommand: ["true"] } }) }))
      .catch((e: unknown) => e)) as DeploymentFailedError;
    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(error.deployment.failedStage).toBe(S.HEALTH_CHECKING);
  });

  it("runs a private web service: health-checked, reachable by name, not routed", async () => {
    const h = harness({ routed: true });
    const state = await h.engine.run(job({ service: spec({ public: false, port: 4000 }) }));

    expect(state).toMatchObject({ status: S.RUNNING, containerPort: 4000, deploymentUrl: null });
    expect(h.calls).toContain("network:shipyard-p-test");
    expect(h.calls).toContain("private:shipyard-p-test=api");
    expect(h.calls.some((c) => c.startsWith("health:"))).toBe(true);
    expect(h.calls.some((c) => c.startsWith("route:"))).toBe(false);
  });

  it("routes a public service under its route name, and runs a configured start command", async () => {
    const h = harness({ routed: true });
    const state = await h.engine.run(job({ routeName: "admin-hello", service: spec({ alias: "admin", startCommand: "node admin.js" }) }));
    expect(state.deploymentUrl).toBe("http://admin-hello.localhost");
    expect(h.calls).toContain('command:["sh","-c","node admin.js"]'); // with the repository's Dockerfile
  });

  it.each([
    ["missing", "nope", "doesn't exist"],
    ["a file", "Dockerfile", "is not a directory"],
  ])("refuses a service directory that is %s", async (_case, sourceDir, message) => {
    const h = harness();
    const error = (await h.engine.run(job({ service: spec({ sourceDir }) })).catch((e: unknown) => e)) as DeploymentFailedError;
    expect(error.message).toContain(message);
    expect(error.deployment.failedStage).toBe(S.DETECTING);
  });

  it("refuses a service directory that is a symlink out of the repository", async () => {
    const outside = await fs.mkdtemp(path.join(tmpRoot, "outside-"));
    const h = harness({ files: {} });
    // The fake clone writes files; add the symlink through a source that also creates it.
    const engine = new DeploymentEngine({
      ...(h.engine as unknown as { deps: DeploymentEngineDeps }).deps,
      source: {
        async clone(_repo, destination) {
          await fs.mkdir(destination, { recursive: true });
          await fs.symlink(outside, path.join(destination, "escape"));
          return { path: destination, commitSha: COMMIT };
        },
      },
    });
    const error = (await engine.run(job({ service: spec({ sourceDir: "escape" }) })).catch((e: unknown) => e)) as DeploymentFailedError;
    expect(error.message).toContain("points outside the repository");
  });

  it("a failing observer fails the deployment instead of being ignored", async () => {
    const h = harness();
    let calls = 0;
    const error = await h.engine
      .run(job(), {
        onStatusChange: () => {
          calls += 1;
          if (calls === 2) throw new Error("database unavailable");
        },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeploymentFailedError);
    expect((error as DeploymentFailedError).deployment.errorMessage).toBe("database unavailable");
  });
});
