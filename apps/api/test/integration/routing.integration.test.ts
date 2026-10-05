import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import { DeploymentEngine, type DeploymentFailedError } from "../../src/services/deployment/DeploymentEngine.js";
import { HealthCheckService } from "../../src/services/deployment/HealthCheckService.js";
import type { DeploymentJob, DeploymentState } from "../../src/services/deployment/types.js";
import { DockerService } from "../../src/services/docker/DockerService.js";
import type { SourceProvider } from "../../src/services/git/GitService.js";
import { parseRepositoryUrl } from "../../src/services/git/repositoryUrl.js";
import { DEPLOYMENT_HEADER, TraefikRouter, createTraefikProbe } from "../../src/services/routing/TraefikRouter.js";
import { LocalRegistry } from "../../src/services/registry/ImageRegistry.js";
import { WorkspaceService } from "../../src/services/workspace/WorkspaceService.js";
import { silentLogger } from "../helpers/silentLogger.js";

// Zero-downtime redeploys, proven against the real thing: Docker, the Traefik
// image from docker-compose.yml, real builds, and visitors hitting the app the
// whole time. Traefik runs on its own network and port, so this never touches
// the development setup.

const here = path.dirname(fileURLToPath(import.meta.url));
const HELLO_APP = path.resolve(here, "../../../../examples/hello-node");
const CRASHING_APP = path.resolve(here, "../fixtures/crashing-app");
const REPLICA_APP = path.resolve(here, "../fixtures/replica-app");
const COMPOSE_FILE = path.resolve(here, "../../../../docker-compose.yml");

const suffix = randomUUID().slice(0, 8);
const NETWORK = `shipyard-it-edge-${suffix}`;
const ROUTE = "hello";
const HOSTNAME = `${ROUTE}.localhost`;

const dockerode = new Docker();
const docker = new DockerService(dockerode, { publishHost: "127.0.0.1", buildTimeoutMs: 300_000 }, silentLogger);
const created: DeploymentState[] = [];
let traefik: Docker.Container | null = null;
let traefikPort: number;
let routesDir: string;
let workspaceRoot: string;
let router: TraefikRouter;

function engine(sourceDir: string): DeploymentEngine {
  const source: SourceProvider = {
    async clone(_repo, destination) {
      await fs.cp(sourceDir, destination, { recursive: true });
      return { path: destination, commitSha: "0".repeat(40) };
    },
  };
  return new DeploymentEngine({
    source,
    docker,
    healthCheck: new HealthCheckService({ timeoutMs: 30_000, intervalMs: 500, requestTimeoutMs: 2_000 }),
    workspace: new WorkspaceService(workspaceRoot),
    router,
    registry: new LocalRegistry(),
    logger: silentLogger,
  });
}

function job(): DeploymentJob {
  return {
    id: randomUUID(),
    repository: parseRepositoryUrl("https://github.com/shipyard-test/hello", ["github.com"]),
    branch: null,
    name: ROUTE,
  };
}

interface Visit {
  status: number;
  servedBy: string | null;
}

/** One visitor request to hello.localhost, through Traefik. */
function visit(): Promise<Visit> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port: traefikPort, path: "/", headers: { host: HOSTNAME }, agent: false, timeout: 5_000 },
      (response) => {
        response.resume();
        response.on("end", () => {
          const servedBy = response.headers[DEPLOYMENT_HEADER.toLowerCase()];
          resolve({ status: response.statusCode ?? 0, servedBy: typeof servedBy === "string" ? servedBy : null });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

/** Four visitors requesting non-stop until stop() is called. */
function keepVisiting() {
  const visits: Visit[] = [];
  let running = true;
  const visitors = Array.from({ length: 4 }, async () => {
    while (running) {
      visits.push(await visit().catch((error: NodeJS.ErrnoException) => ({ status: 0, servedBy: error.code ?? error.message })));
    }
  });
  return {
    visits,
    async stop() {
      running = false;
      await Promise.all(visitors);
      return visits;
    },
  };
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function traefikImage(): Promise<string> {
  const image = /image:\s*(traefik:\S+)/.exec(await fs.readFile(COMPOSE_FILE, "utf8"))?.[1];
  if (!image) throw new Error("No traefik image in docker-compose.yml");
  const present = await dockerode.getImage(image).inspect().then(() => true, () => false);
  if (!present) {
    const stream = await dockerode.pull(image);
    await new Promise((resolve, reject) => dockerode.modem.followProgress(stream, (error) => (error ? reject(error) : resolve(null))));
  }
  return image;
}

beforeAll(async () => {
  if (!(await docker.ping())) {
    throw new Error("Docker daemon is not reachable — start Docker Desktop before running integration tests.");
  }
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-it-"));
  // realpath: on macOS the temp dir is a symlink, and Docker must mount the real directory.
  routesDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-it-routes-")));
  traefikPort = await freePort();

  await dockerode.createNetwork({ Name: NETWORK });
  traefik = await dockerode.createContainer({
    Image: await traefikImage(),
    name: `shipyard-it-traefik-${suffix}`,
    Cmd: [
      "--entrypoints.web.address=:80",
      "--providers.file.directory=/etc/traefik/dynamic",
      "--providers.file.watch=true",
      "--log.level=ERROR",
    ],
    ExposedPorts: { "80/tcp": {} },
    HostConfig: {
      NetworkMode: NETWORK,
      PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(traefikPort) }] },
      Binds: [`${routesDir}:/etc/traefik/dynamic:ro`],
    },
  });
  await traefik.start();

  router = new TraefikRouter(
    { network: NETWORK, domain: "localhost", httpPort: traefikPort, routesDir, cutoverTimeoutMs: 20_000, probeIntervalMs: 100 },
    createTraefikProbe(traefikPort, 2_000),
    silentLogger,
  );
  await router.sync([]);
});

afterAll(async () => {
  for (const record of created) {
    if (record.containerId) await docker.removeContainer(record.containerId);
    for (const id of await docker.deploymentContainers(record.id)) await docker.removeContainer(id); // other replicas
    await docker.removeImage(record.imageName);
  }
  await traefik?.remove({ force: true });
  await dockerode.getNetwork(NETWORK).remove().catch(() => {});
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(routesDir, { recursive: true, force: true });
});

describe("Traefik routing against real Docker", () => {
  let first: DeploymentState;
  let second: DeploymentState;

  it("serves a deployment at its stable hostname, reachable only through the proxy network", async () => {
    first = await engine(HELLO_APP).run(job());
    created.push(first);

    expect(first.deploymentUrl).toBe(`http://${HOSTNAME}:${traefikPort}`);
    expect(await visit()).toEqual({ status: 200, servedBy: first.id });

    const info = await dockerode.getContainer(first.containerId!).inspect();
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([NETWORK]);
    // The published port is for Shipyard's health checks only: loopback, never the network.
    expect(info.HostConfig.PortBindings?.["3000/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
  });

  it("redeploys with zero downtime: every visitor request succeeds while traffic moves over", async () => {
    const traffic = keepVisiting();
    await sleep(300);

    second = await engine(HELLO_APP).run(job());
    created.push(second);
    // What DeploymentService does next: retire the previous deployment.
    await router.deactivate(ROUTE, first.id);
    await docker.stopContainer(first.containerId!);
    await sleep(500);

    const visits = await traffic.stop();
    expect(visits.filter((v) => v.status !== 200)).toEqual([]);
    const servedBy = new Set(visits.map((v) => v.servedBy));
    expect(servedBy).toEqual(new Set([first.id, second.id]));
    expect(visits.length).toBeGreaterThan(20);

    for (let i = 0; i < 10; i += 1) expect(await visit()).toEqual({ status: 200, servedBy: second.id });
  });

  it("a deployment that never gets healthy never receives traffic", async () => {
    const traffic = keepVisiting();
    const error = (await engine(CRASHING_APP).run(job()).catch((e: unknown) => e)) as DeploymentFailedError;
    created.push(error.deployment);
    const visits = await traffic.stop();

    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(new Set(visits.map((v) => `${v.status} ${v.servedBy}`))).toEqual(new Set([`200 ${second.id}`]));
  });

  it("rolls back by restarting the previous deployment, again without downtime", async () => {
    const traffic = keepVisiting();
    const restarted = await engine(HELLO_APP).restart(first.containerName, { name: ROUTE });
    await router.deactivate(ROUTE, second.id);
    await docker.stopContainer(second.containerId!);
    const visits = await traffic.stop();

    expect(restarted.deploymentUrl).toBe(`http://${HOSTNAME}:${traefikPort}`);
    expect(visits.filter((v) => v.status !== 200)).toEqual([]);
    expect(await visit()).toEqual({ status: 200, servedBy: first.id });
  });

  it("taking the live deployment out of the router leaves the hostname unrouted (404)", async () => {
    await router.deactivate(ROUTE, first.id);
    let last: Visit = await visit();
    for (let i = 0; i < 50 && last.status !== 404; i += 1) {
      await sleep(200);
      last = await visit();
    }
    expect(last).toEqual({ status: 404, servedBy: null });
  });
});

describe("replicas behind Traefik", () => {
  const ROUTE_R = "replicas";
  const replicaJob = (): DeploymentJob => ({
    ...job(),
    name: ROUTE_R,
    replicas: 2,
    healthCheck: { path: "/healthz", port: null, timeoutMs: null },
  });

  /** One request to replicas.localhost; the body is the serving container's hostname. */
  function ask(): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port: traefikPort, path: "/", headers: { host: `${ROUTE_R}.localhost` }, agent: false, timeout: 5_000 },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on("timeout", () => request.destroy(new Error("timed out")));
      request.on("error", reject);
    });
  }

  let first: DeploymentState;

  it("spreads requests across every replica", async () => {
    first = await engine(REPLICA_APP).run(replicaJob());
    created.push(first);
    expect(first.replicas).toBe(2);
    const answers = await Promise.all(Array.from({ length: 20 }, () => ask()));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(new Set(answers.map((a) => a.body)).size).toBe(2);
  });

  it("a rolling redeploy of all replicas fails no request", async () => {
    let running = true;
    const results: number[] = [];
    const visitors = Array.from({ length: 4 }, async () => {
      while (running) results.push(await ask().then((a) => a.status, () => 0));
    });
    const second = await engine(REPLICA_APP).run(replicaJob());
    created.push(second);
    // What DeploymentService does next: retire the old replicas (drained by docker stop's grace period).
    await engine(REPLICA_APP).stop(first.containerId!);
    await sleep(500);
    running = false;
    await Promise.all(visitors);

    expect(results.filter((status) => status !== 200)).toEqual([]);
    expect(results.length).toBeGreaterThan(20);
    for (const id of await docker.deploymentContainers(first.id)) {
      expect((await dockerode.getContainer(id).inspect()).State.Running).toBe(false); // both old replicas stopped
    }
    first = second;
  });

  it("Traefik stops sending traffic to a replica that dies", async () => {
    const [, replica2] = await docker.deploymentContainers(first.id);
    await dockerode.getContainer(replica2!).kill();
    // Traefik notices within a few of its 2s checks; until then some requests may fail.
    let answers: Array<{ status: number; body: string }> = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(1_000);
      answers = await Promise.all(Array.from({ length: 10 }, () => ask().catch(() => ({ status: 0, body: "" }))));
      if (answers.every((a) => a.status === 200)) break;
    }
    expect(answers.map((a) => a.status)).toEqual(Array(10).fill(200));
    expect(new Set(answers.map((a) => a.body)).size).toBe(1); // only the surviving replica
  });
});
