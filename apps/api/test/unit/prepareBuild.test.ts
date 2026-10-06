import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import { GENERATED_DOCKERFILE_NAME, prepareBuild } from "../../src/services/build/prepareBuild.js";

let dir: string;
let log: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-prepare-"));
  log = "";
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const collect = (text: string) => void (log += text);

describe("prepareBuild", () => {
  it("uses the repository's Dockerfile when there is one, even next to package.json", async () => {
    await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node\nEXPOSE 8080\n");
    await fs.writeFile(path.join(dir, "package.json"), "{}");

    expect(await prepareBuild(dir, collect)).toMatchObject({ dockerfile: "Dockerfile", containerPort: 8080, source: "repository", contextDir: await fs.realpath(dir) });
    expect(await fs.readdir(dir)).not.toContain(GENERATED_DOCKERFILE_NAME);
  });

  it("generates a Dockerfile and .dockerignore for a Node project", async () => {
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));

    expect(await prepareBuild(dir, collect)).toMatchObject({
      dockerfile: GENERATED_DOCKERFILE_NAME,
      containerPort: 3000,
      source: "generated",
    });
    expect(await fs.readFile(path.join(dir, GENERATED_DOCKERFILE_NAME), "utf8")).toContain('CMD ["npm","start"]');
    expect(await fs.readFile(path.join(dir, ".dockerignore"), "utf8")).toContain("node_modules");
    expect(log).toContain("detected a Node.js project (npm, Node 24)");
    expect(log).toContain("  FROM node:24-slim");
  });

  it("keeps the repository's own .dockerignore", async () => {
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "x" } }));
    await fs.writeFile(path.join(dir, ".dockerignore"), "custom\n");

    await prepareBuild(dir, collect);
    expect(await fs.readFile(path.join(dir, ".dockerignore"), "utf8")).toBe("custom\n");
  });

  it("refuses to write through a symlink planted at the generated Dockerfile's name", async () => {
    const outside = path.join(os.tmpdir(), `shipyard-outside-${path.basename(dir)}`);
    await fs.writeFile(outside, "original");
    try {
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "x" } }));
      await fs.symlink(outside, path.join(dir, GENERATED_DOCKERFILE_NAME));

      await expect(prepareBuild(dir, collect)).rejects.toMatchObject({ code: ErrorCode.PROJECT_DETECTION_FAILED });
      expect(await fs.readFile(outside, "utf8")).toBe("original");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("fails with DOCKERFILE_NOT_FOUND when there is neither a Dockerfile nor package.json", async () => {
    await expect(prepareBuild(dir, collect)).rejects.toMatchObject({
      code: ErrorCode.DOCKERFILE_NOT_FOUND,
      statusCode: 422,
    });
  });
});
