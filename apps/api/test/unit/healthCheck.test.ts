import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { AppError, ErrorCode } from "../../src/lib/errors.js";
import { HealthCheckService } from "../../src/services/deployment/HealthCheckService.js";

// These tests use a REAL HTTP server on a random local port — no mocked fetch.

const running = async () => ({ running: true, exitCode: null });
const fast = { timeoutMs: 2_000, intervalMs: 50, requestTimeoutMs: 500 };

let servers: http.Server[] = [];

async function listen(handler: http.RequestListener, port = 0): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  servers = [];
});

describe("HealthCheckService", () => {
  it("is healthy on HTTP 200", async () => {
    const port = await listen((_req, res) => res.end("ok"));
    const result = await new HealthCheckService(fast).waitUntilHealthy({
      url: `http://127.0.0.1:${port}/`,
      getContainerState: running,
    });
    expect(result).toMatchObject({ statusCode: 200, attempts: 1 });
  });

  it("treats 404 as healthy (server is up, just no route at /)", async () => {
    const port = await listen((_req, res) => res.writeHead(404).end());
    const result = await new HealthCheckService(fast).waitUntilHealthy({
      url: `http://127.0.0.1:${port}/`,
      getContainerState: running,
    });
    expect(result.statusCode).toBe(404);
  });

  it("waits for an app that starts listening late", async () => {
    const port = await freePort();
    setTimeout(() => void listen((_req, res) => res.end("ok"), port), 300);

    const result = await new HealthCheckService(fast).waitUntilHealthy({
      url: `http://127.0.0.1:${port}/`,
      getContainerState: running,
    });
    expect(result.attempts).toBeGreaterThan(1);
  });

  it("fails after the timeout when the app keeps returning 5xx", async () => {
    const port = await listen((_req, res) => res.writeHead(503).end());
    const check = new HealthCheckService({ ...fast, timeoutMs: 300 }).waitUntilHealthy({
      url: `http://127.0.0.1:${port}/`,
      getContainerState: running,
    });
    await expect(check).rejects.toThrow(/HTTP 503/);
  });

  it("fails fast with the exit code when the container has crashed", async () => {
    const check = new HealthCheckService(fast).waitUntilHealthy({
      url: "http://127.0.0.1:1/",
      getContainerState: async () => ({ running: false, exitCode: 137 }),
    });
    await expect(check).rejects.toMatchObject({
      code: ErrorCode.HEALTH_CHECK_FAILED,
      message: expect.stringContaining("code 137"),
    });
    await expect(check).rejects.toBeInstanceOf(AppError);
  });

  it("reports connection refused when nothing listens", async () => {
    const port = await freePort();
    const check = new HealthCheckService({ ...fast, timeoutMs: 200 }).waitUntilHealthy({
      url: `http://127.0.0.1:${port}/`,
      getContainerState: running,
    });
    await expect(check).rejects.toThrow(/ECONNREFUSED/);
  });
});
