import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError, ErrorCode } from "../../src/lib/errors.js";
import {
  DeploymentEngine,
  DeploymentFailedError,
  type EngineDocker,
} from "../../src/services/deployment/DeploymentEngine.js";
import { DeploymentStatus as S } from "../../src/services/deployment/status.js";
import type { DeploymentStatus } from "../../src/services/deployment/status.js";
import type { DeploymentJob, DeploymentObserver } from "../../src/services/deployment/types.js";
import type { SourceProvider } from "../../src/services/git/GitService.js";
import { parseRepositoryUrl } from "../../src/services/git/repositoryUrl.js";
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
    healthFails?: boolean;
    /** Behave like the Traefik router (own network, hostname URLs) instead of plain ports. */
    routed?: boolean;
    routeFails?: boolean;
  } = {},
): Harness {
  const calls: string[] = [];
  const statuses: DeploymentStatus[] = [];
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
    async buildImage(ctx: string, imageName: string, labels: Record<string, string>, _onLog, dockerfile = "Dockerfile") {
      calls.push(`build:${imageName}:${labels["shipyard.container-port"]}:${labels["shipyard.project-id"]}`);
      calls.push(`dockerfile:${dockerfile}:${await fs.readFile(path.join(ctx, dockerfile), "utf8").then(() => "present", () => "missing")}`);
      if (options.buildFails) {
        throw new AppError(ErrorCode.DOCKER_BUILD_FAILED, "Docker build failed: npm ci exited 1");
      }
    },
    async createAndStartContainer(opts) {
      calls.push(`start:${opts.containerName}:${opts.containerPort}:${opts.network ?? "bridge"}`);
      return { id: "container-id", hostPort: 49153 };
    },
    async getContainerState() {
      return { running: true, exitCode: null };
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
    connectToNetwork: unused,
    removeContainer: unused,
    removeImage: unused,
  };

  const router: Router = {
    network: options.routed ? "shipyard-edge" : null,
    urlFor: (name, hostPort) => (options.routed ? `http://${name}.localhost` : `http://localhost:${hostPort}`),
    async activate(target) {
      calls.push(`route:${target.name}->${target.containerName}:${target.containerPort}`);
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
      async waitUntilHealthy({ url }) {
        calls.push(`health:${url}`);
        if (options.healthFails) {
          throw new AppError(ErrorCode.HEALTH_CHECK_FAILED, "Container exited with code 1 before becoming healthy.");
        }
        return { statusCode: 200, attempts: 1, durationMs: 5 };
      },
    },
    workspace: new WorkspaceService(workspaceRoot),
    router,
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

    expect(h.statuses).toEqual([S.CLONING, S.BUILDING, S.STARTING, S.HEALTHY, S.RUNNING]);
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
    expect(order).toEqual([S.CLONING, S.BUILDING, S.STARTING, S.HEALTHY, S.RUNNING]);
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
    expect(h.statuses).toEqual([S.CLONING, S.FAILED]);
  });

  it("fails with DOCKERFILE_NOT_FOUND and cleans up the clone", async () => {
    const h = harness({ dockerfile: null });
    const error = await h.engine.run(job(), h.observer).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeploymentFailedError);
    expect((error as DeploymentFailedError).code).toBe(ErrorCode.DOCKERFILE_NOT_FOUND);
    expect((error as DeploymentFailedError).deployment.status).toBe(S.FAILED);
    expect(h.statuses).toEqual([S.CLONING, S.FAILED]);
    expect(await workspaceEntries(h.workspaceRoot)).toEqual([]);
  });

  it("records build failures and never starts a container", async () => {
    const h = harness({ buildFails: true });
    const error = (await h.engine.run(job(), h.observer).catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error.code).toBe(ErrorCode.DOCKER_BUILD_FAILED);
    expect(error.deployment.errorMessage).toContain("npm ci exited 1");
    expect(h.statuses).toEqual([S.CLONING, S.BUILDING, S.FAILED]);
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
    expect(h.statuses).toEqual([S.CLONING, S.BUILDING, S.STARTING, S.FAILED]);
    expect(h.calls.slice(-2)).toEqual(["logs", "stop:container-id"]);
    expect(logs).toEqual(["Error: listen EADDRINUSE\n"]);
    expect(error.deployment).toMatchObject({ containerId: "container-id", deploymentUrl: null });
  });

  it("with a proxy: joins its network and moves the hostname only once the app is healthy", async () => {
    const h = harness({ routed: true });
    const state = await h.engine.run(job(), { onStatusChange: (record) => void h.calls.push(record.status) });

    expect(h.calls).toContain("start:shipyard-hello-3f2a9c1e77b4:8080:shipyard-edge");
    expect(h.calls.slice(-4)).toEqual([
      "health:http://127.0.0.1:49153/",
      S.HEALTHY,
      "route:hello->shipyard-hello-3f2a9c1e77b4:8080",
      S.RUNNING,
    ]);
    expect(state.deploymentUrl).toBe("http://hello.localhost");
  });

  it("when traffic can't be moved: FAILED, container stopped, so the previous deployment keeps serving", async () => {
    const h = harness({ routed: true, routeFails: true });
    const error = (await h.engine.run(job(), h.observer).catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error.code).toBe(ErrorCode.ROUTING_FAILED);
    expect(h.statuses).toEqual([S.CLONING, S.BUILDING, S.STARTING, S.HEALTHY, S.FAILED]);
    expect(h.calls.at(-1)).toBe("stop:container-id");
    expect(error.deployment.deploymentUrl).toBeNull();
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
