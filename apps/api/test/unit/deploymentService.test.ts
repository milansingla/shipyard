import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError, ErrorCode, ValidationError } from "../../src/lib/errors.js";
import {
  type DeploymentDocker,
  DeploymentFailedError,
  DeploymentService,
} from "../../src/services/deployment/DeploymentService.js";
import { DeploymentStatus as S } from "../../src/services/deployment/status.js";
import type { DeploymentStatus } from "../../src/services/deployment/status.js";
import type { SourceProvider } from "../../src/services/git/GitService.js";
import { WorkspaceService } from "../../src/services/workspace/WorkspaceService.js";
import { silentLogger } from "../helpers/silentLogger.js";

// Orchestration tests: fake git + Docker so we can assert ordering, status
// transitions and failure handling deterministically. The real Docker path
// is covered by test/integration/deployment.integration.test.ts.

const COMMIT = "a".repeat(40);
const REPO_URL = "https://github.com/octocat/hello";

interface Harness {
  service: DeploymentService;
  calls: string[];
  statuses: DeploymentStatus[];
  observer: { onStatusChange: (r: { status: DeploymentStatus }) => void; onLog: () => void };
  workspaceRoot: string;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-deploy-"));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function harness(options: {
  dockerfile?: string | null;
  buildFails?: boolean;
  healthFails?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const statuses: DeploymentStatus[] = [];
  const workspaceRoot = path.join(tmpRoot, "ws");

  const source: SourceProvider = {
    async clone(_repo, destination, branch) {
      calls.push(`clone:${branch ?? "default"}`);
      await fs.mkdir(destination, { recursive: true });
      const dockerfile = options.dockerfile === undefined ? "FROM node\nEXPOSE 8080\n" : options.dockerfile;
      if (dockerfile !== null) await fs.writeFile(path.join(destination, "Dockerfile"), dockerfile);
      return { path: destination, commitSha: COMMIT };
    },
  };

  const docker: DeploymentDocker = {
    async buildImage(_ctx, imageName, labels) {
      calls.push(`build:${imageName}:${labels["shipyard.container-port"]}`);
      if (options.buildFails) {
        throw new AppError(ErrorCode.DOCKER_BUILD_FAILED, "Docker build failed: npm ci exited 1");
      }
    },
    async createAndStartContainer(opts) {
      calls.push(`start:${opts.containerName}:${opts.containerPort}`);
      return { id: "container-id", hostPort: 49153 };
    },
    async getContainerState() {
      return { running: true, exitCode: null };
    },
    async getLogs() {
      calls.push("logs");
      return [{ stream: "stderr" as const, text: "Error: listen EADDRINUSE\n" }];
    },
    async stopContainer(id) {
      calls.push(`stop:${id}`);
    },
    async inspectManagedContainer() {
      throw new Error("not used");
    },
    async restartContainer() {
      throw new Error("not used");
    },
  };

  const service = new DeploymentService({
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
    logger: silentLogger,
    allowedGitHosts: ["github.com"],
  });

  return {
    service,
    calls,
    statuses,
    observer: { onStatusChange: (r) => statuses.push(r.status), onLog: () => {} },
    workspaceRoot,
  };
}

async function workspaceEntries(root: string): Promise<string[]> {
  return fs.readdir(root).catch(() => []);
}

describe("DeploymentService.deploy", () => {
  it("runs the full pipeline and ends RUNNING", async () => {
    const h = harness();
    const record = await h.service.deploy({ repositoryUrl: REPO_URL, branch: "main" }, h.observer);

    expect(h.statuses).toEqual([S.CLONING, S.BUILDING, S.STARTING, S.HEALTHY, S.RUNNING]);
    expect(h.calls).toEqual([
      "clone:main",
      `build:${record.imageName}:8080`,
      `start:${record.containerName}:8080`,
      "health:http://127.0.0.1:49153/",
    ]);
    expect(record).toMatchObject({
      status: S.RUNNING,
      repositoryUrl: "https://github.com/octocat/hello.git",
      repositoryOwner: "octocat",
      repositoryName: "hello",
      branch: "main",
      commitSha: COMMIT,
      containerId: "container-id",
      containerPort: 8080,
      hostPort: 49153,
      deploymentUrl: "http://localhost:49153",
      errorMessage: null,
    });
    expect(record.imageName).toMatch(/^shipyard\/hello:[0-9a-f]{12}$/);
    expect(record.startedAt).toBeInstanceOf(Date);
    expect(record.finishedAt).toBeInstanceOf(Date);
    // Clone is deleted once the image is built.
    expect(await workspaceEntries(h.workspaceRoot)).toEqual([]);
  });

  it("defaults to port 3000 and the default branch", async () => {
    const h = harness({ dockerfile: "FROM node\nCMD node index.js\n" });
    const record = await h.service.deploy({ repositoryUrl: REPO_URL }, h.observer);
    expect(record.containerPort).toBe(3000);
    expect(record.branch).toBeNull();
    expect(h.calls[0]).toBe("clone:default");
  });

  it("rejects invalid input before creating a deployment", async () => {
    const h = harness();
    await expect(h.service.deploy({ repositoryUrl: "file:///etc" }, h.observer)).rejects.toThrow(ValidationError);
    await expect(h.service.deploy({ repositoryUrl: REPO_URL, branch: "--evil" }, h.observer)).rejects.toThrow(
      ValidationError,
    );
    expect(h.statuses).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("fails with DOCKERFILE_NOT_FOUND and cleans up the clone", async () => {
    const h = harness({ dockerfile: null });
    const error = await h.service.deploy({ repositoryUrl: REPO_URL }, h.observer).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeploymentFailedError);
    expect((error as DeploymentFailedError).code).toBe(ErrorCode.DOCKERFILE_NOT_FOUND);
    expect((error as DeploymentFailedError).deployment.status).toBe(S.FAILED);
    expect(h.statuses).toEqual([S.CLONING, S.FAILED]);
    expect(await workspaceEntries(h.workspaceRoot)).toEqual([]);
  });

  it("records build failures and never starts a container", async () => {
    const h = harness({ buildFails: true });
    const error = (await h.service.deploy({ repositoryUrl: REPO_URL }, h.observer).catch((e: unknown) => e)) as
      DeploymentFailedError;

    expect(error.code).toBe(ErrorCode.DOCKER_BUILD_FAILED);
    expect(error.deployment.errorMessage).toContain("npm ci exited 1");
    expect(h.statuses).toEqual([S.CLONING, S.BUILDING, S.FAILED]);
    expect(h.calls.some((c) => c.startsWith("start:"))).toBe(false);
    expect(await workspaceEntries(h.workspaceRoot)).toEqual([]);
  });

  it("on health-check failure: collects runtime logs, stops the container, ends FAILED", async () => {
    const h = harness({ healthFails: true });
    const logs: string[] = [];
    const error = (await h.service
      .deploy(
        { repositoryUrl: REPO_URL },
        { ...h.observer, onLog: (source, text) => source === "runtime" && logs.push(text) },
      )
      .catch((e: unknown) => e)) as DeploymentFailedError;

    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(h.statuses).toEqual([S.CLONING, S.BUILDING, S.STARTING, S.FAILED]);
    expect(h.calls.slice(-2)).toEqual(["logs", "stop:container-id"]);
    expect(logs).toEqual(["Error: listen EADDRINUSE\n"]);
    expect(error.deployment).toMatchObject({ containerId: "container-id", deploymentUrl: null });
  });
});
