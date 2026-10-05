import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectDockerfile, parseExposedPort } from "../../src/services/detection/dockerfile.js";

describe("parseExposedPort", () => {
  it.each([
    ["FROM node\nEXPOSE 3000\n", 3000],
    ["expose 8080", 8080],
    ["EXPOSE 5000/tcp", 5000],
    ["EXPOSE 8080 9090", 8080],
    ["FROM a AS build\nEXPOSE 1111\nFROM b\nEXPOSE 2222", 2222],
  ])("%j → %d", (dockerfile, expected) => {
    expect(parseExposedPort(dockerfile)).toBe(expected);
  });

  it.each([
    ["FROM node\nCMD node server.js", "no EXPOSE"],
    ["# EXPOSE 3000", "commented out"],
    ["EXPOSE ${PORT}", "variable"],
    ["EXPOSE 53/udp", "udp"],
    ["EXPOSE 70000", "out of range"],
    ["EXPOSE 0", "zero"],
  ])("%j → null (%s)", (dockerfile) => {
    expect(parseExposedPort(dockerfile)).toBeNull();
  });
});

describe("detectDockerfile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-detect-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when there is no Dockerfile", async () => {
    expect(await detectDockerfile(dir)).toBeNull();
  });

  it("detects a Dockerfile and its port", async () => {
    await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node:24-alpine\nEXPOSE 4321\n");
    expect(await detectDockerfile(dir)).toEqual({ path: path.join(dir, "Dockerfile"), exposedPort: 4321 });
  });

  it("ignores a Dockerfile that is a symlink (could point outside the clone)", async () => {
    const outside = path.join(dir, "..", `outside-${path.basename(dir)}`);
    await fs.writeFile(outside, "EXPOSE 1234");
    try {
      await fs.symlink(outside, path.join(dir, "Dockerfile"));
      expect(await detectDockerfile(dir)).toBeNull();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("ignores a directory named Dockerfile", async () => {
    await fs.mkdir(path.join(dir, "Dockerfile"));
    expect(await detectDockerfile(dir)).toBeNull();
  });
});
