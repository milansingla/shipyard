import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { AppError, ErrorCode } from "../../src/lib/errors.js";
import { createErrorHandler } from "../../src/middleware/errorHandler.js";
import type { DeploymentService } from "../../src/modules/deployments/DeploymentService.js";
import type { ProjectService } from "../../src/modules/projects/ProjectService.js";
import { silentLogger } from "../helpers/silentLogger.js";

let server: Server | undefined;

async function start(app: express.Express): Promise<string> {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

function appWithDocker(reachable: boolean) {
  return createApp({ docker: { ping: async () => reachable }, logger: silentLogger, exposeInternalErrors: false });
}

describe("HTTP API", () => {
  it("GET /api/health → 200 when Docker is reachable", async () => {
    const base = await start(appWithDocker(true));
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: "ok", docker: "reachable" } });
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("GET /api/health → 503 when Docker is unreachable", async () => {
    const base = await start(appWithDocker(false));
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ data: { status: "degraded", docker: "unreachable" } });
  });

  it("unknown routes return the standard error envelope", async () => {
    const base = await start(appWithDocker(true));
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found: GET /api/nope" } });
  });
});

describe("authentication", () => {
  it("protected routes explain the missing setup (503) when GitHub sign-in is not configured", async () => {
    const base = await start(
      createApp({
        docker: { ping: async () => true },
        // Never reached: requireUser() rejects first.
        projects: {} as ProjectService,
        deployments: {} as DeploymentService,
        logger: silentLogger,
        exposeInternalErrors: false,
      }),
    );
    for (const route of ["/api/projects", "/api/auth/me", "/api/auth/github/login", "/api/github/repos"]) {
      const res = await fetch(`${base}${route}`);
      expect({ route, status: res.status }).toEqual({ route, status: 503 });
      expect(await res.json()).toMatchObject({ error: { code: "AUTH_NOT_CONFIGURED" } });
    }
  });
});

describe("error handler", () => {
  function appThatThrows(error: unknown, exposeInternalErrors: boolean) {
    const app = express();
    app.get("/boom", () => {
      throw error;
    });
    app.use(createErrorHandler(silentLogger, exposeInternalErrors));
    return app;
  }

  it("maps AppError to its status code and code", async () => {
    const base = await start(
      appThatThrows(new AppError(ErrorCode.DOCKERFILE_NOT_FOUND, "No Dockerfile", { statusCode: 422 }), false),
    );
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "DOCKERFILE_NOT_FOUND", message: "No Dockerfile" } });
  });

  it("hides unexpected error details in production", async () => {
    const base = await start(appThatThrows(new Error("db password is hunter2"), false));
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("hunter2");
    expect(JSON.parse(body)).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
  });
});
