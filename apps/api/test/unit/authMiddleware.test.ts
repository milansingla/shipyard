import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { readCookie } from "../../src/lib/cookies.js";
import { createErrorHandler } from "../../src/middleware/errorHandler.js";
import { originCheck } from "../../src/middleware/originCheck.js";
import { silentLogger } from "../helpers/silentLogger.js";

describe("readCookie", () => {
  it.each([
    ["a=1; shipyard_session=abc; b=2", "abc"],
    ["shipyard_session=a%20b", "a b"],
    ["shipyard_session_x=nope; shipyard_session=yes", "yes"],
  ])("%j → %j", (header, value) => {
    expect(readCookie(header, "shipyard_session")).toBe(value);
  });

  it.each([undefined, "", "other=1", "shipyard_session", "shipyard_session=%E0%A4%A"])("%j → undefined", (header) => {
    expect(readCookie(header, "shipyard_session")).toBeUndefined();
  });
});

describe("originCheck", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
  });

  async function start(): Promise<string> {
    const app = express();
    app.use(originCheck(["http://localhost:4000", "http://localhost:3000/"]));
    app.all("/x", (_req, res) => void res.status(204).end());
    app.use(createErrorHandler(silentLogger, false));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  }

  it.each([
    ["GET from anywhere", "GET", { origin: "https://evil.example" }, 204],
    ["POST without browser headers (curl)", "POST", {}, 204],
    ["POST from the API origin", "POST", { origin: "http://localhost:4000" }, 204],
    ["POST from the dashboard origin", "POST", { origin: "http://localhost:3000" }, 204],
    ["POST from another site", "POST", { origin: "https://evil.example" }, 403],
    ["DELETE from another site", "DELETE", { origin: "https://evil.example" }, 403],
    ["POST marked cross-site without Origin", "POST", { "sec-fetch-site": "cross-site" }, 403],
    ["POST with Origin: null (sandboxed frame)", "POST", { origin: "null" }, 403],
  ])("%s → %d", async (_name, method, headers, status) => {
    const res = await fetch(await start(), { method, headers });
    expect(res.status).toBe(status);
  });
});
