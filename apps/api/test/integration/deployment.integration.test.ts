import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import { DeploymentEngine, DeploymentFailedError } from "../../src/services/deployment/DeploymentEngine.js";
import { HealthCheckService } from "../../src/services/deployment/HealthCheckService.js";
import { DeploymentStatus as S } from "../../src/services/deployment/status.js";
import type { DeploymentJob, DeploymentState } from "../../src/services/deployment/types.js";
import { DockerService } from "../../src/services/docker/DockerService.js";
import { formatLogChunks } from "../../src/services/docker/logs.js";
import type { SourceProvider } from "../../src/services/git/GitService.js";
import { parseRepositoryUrl } from "../../src/services/git/repositoryUrl.js";
import { DirectPortRouter } from "../../src/services/routing/Router.js";
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
});
