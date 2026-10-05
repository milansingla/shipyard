import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseFrame } from "../src/client.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { type Io, USAGE, main, table } from "../src/main.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-cli-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function io(overrides: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { env: {}, stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t), readLine: async () => "", configPath: path.join(dir, "cli.json"), ...overrides },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("shipyard CLI", () => {
  it("prints usage", async () => {
    const t = io();
    expect(await main([], t.io)).toBe(0);
    expect(t.out()).toBe(USAGE);
  });

  it("asks you to log in first", async () => {
    const t = io();
    expect(await main(["projects"], t.io)).toBe(1);
    expect(t.err()).toContain("shipyard login");
  });

  it("refuses something that isn't an API key before calling the server", async () => {
    const t = io();
    expect(await main(["login", "--url", "http://x", "--token", "gho_github_token"], t.io)).toBe(1);
    expect(t.err()).toContain("doesn't look like a Shipyard API key");
  });

  it("saves the login readable only by you; SHIPYARD_URL/TOKEN take precedence", async () => {
    const file = path.join(dir, "nested", "cli.json");
    await saveConfig(file, { url: "http://saved", token: "shp_saved" });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadConfig(file, {})).toEqual({ url: "http://saved", token: "shp_saved" });
    expect(await loadConfig(file, { SHIPYARD_URL: "http://ci", SHIPYARD_TOKEN: "shp_ci" })).toEqual({ url: "http://ci", token: "shp_ci" });
  });
});

describe("parseFrame", () => {
  it("reads event and JSON data, and skips keep-alive comments", () => {
    expect(parseFrame('event: log\ndata: {"text":"hi\\n"}')).toEqual({ event: "log", data: { text: "hi\n" } });
    expect(parseFrame(": keep-alive")).toBeNull();
  });
});

describe("table", () => {
  it("aligns columns", () => {
    expect(table(["NAME", "STATUS"], [["shop", "RUNNING"], ["blog-api", "FAILED"]])).toBe(
      "NAME      STATUS\nshop      RUNNING\nblog-api  FAILED\n",
    );
  });
});
