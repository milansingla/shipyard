import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import {
  DEFAULT_NODE_MAJOR,
  detectNodeProject,
  isSafeEntryPath,
  selectNodeMajor,
} from "../../src/services/detection/nodeProject.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-node-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(files: Record<string, string | object>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), typeof contents === "string" ? contents : JSON.stringify(contents));
  }
}

describe("detectNodeProject", () => {
  it("returns null when there is no package.json", async () => {
    expect(await detectNodeProject(dir)).toBeNull();
  });

  it("detects an npm project with build and start scripts", async () => {
    await write({
      "package.json": { scripts: { build: "tsc", start: "node dist/server.js" } },
      "package-lock.json": "{}",
    });
    expect(await detectNodeProject(dir)).toEqual({
      packageManager: "npm",
      packageManagerMajor: null,
      lockfile: "package-lock.json",
      nodeMajor: DEFAULT_NODE_MAJOR,
      hasBuildScript: true,
      startCommand: ["npm", "start"],
      dependencyFiles: ["package.json", "package-lock.json"],
      notes: [],
    });
  });

  it("copies package-manager config with the manifests when present", async () => {
    await write({ "package.json": { scripts: { start: "x" } }, "yarn.lock": "", ".npmrc": "registry=…", ".yarnrc": "" });
    expect((await detectNodeProject(dir))?.dependencyFiles).toEqual(["package.json", "yarn.lock", ".npmrc", ".yarnrc"]);
  });

  it.each([
    ["install scripts", { scripts: { start: "x", postinstall: "patch-package" } }, {}, "install scripts (postinstall)"],
    ["npm workspaces", { scripts: { start: "x" }, workspaces: ["packages/*"] }, {}, "workspaces"],
    ["pnpm workspaces", { scripts: { start: "x" } }, { "pnpm-workspace.yaml": "packages: []" }, "workspaces"],
    ["Yarn 2+", { scripts: { start: "x" }, packageManager: "yarn@4.1.0" }, { "yarn.lock": "" }, "Yarn 2+"],
  ])("installs with the whole source for %s, and says why", async (_case, pkg, files, reason) => {
    await write({ "package.json": pkg, ...files });
    const project = await detectNodeProject(dir);
    expect(project?.dependencyFiles).toBeNull();
    expect(project?.notes.join(" ")).toContain(reason);
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["npm-shrinkwrap.json", "npm"],
  ])("detects the package manager from %s", async (lockfile, manager) => {
    await write({ "package.json": { scripts: { start: "x" } }, [lockfile]: "" });
    const project = await detectNodeProject(dir);
    expect(project?.packageManager).toBe(manager);
    expect(project?.startCommand).toEqual([manager, "start"]);
  });

  it("prefers the packageManager field over lockfiles", async () => {
    await write({ "package.json": { packageManager: "yarn@4.5.0+sha512.abc", scripts: { start: "x" } }, "yarn.lock": "" });
    const project = await detectNodeProject(dir);
    expect(project).toMatchObject({ packageManager: "yarn", packageManagerMajor: 4, lockfile: "yarn.lock" });
  });

  it("notes when several lockfiles disagree", async () => {
    await write({ "package.json": { scripts: { start: "x" } }, "pnpm-lock.yaml": "", "package-lock.json": "{}" });
    const project = await detectNodeProject(dir);
    expect(project?.packageManager).toBe("pnpm");
    expect(project?.notes.join()).toContain("pnpm, npm");
  });

  it("falls back to npm without a lockfile, and says so", async () => {
    await write({ "package.json": { scripts: { start: "x" } } });
    const project = await detectNodeProject(dir);
    expect(project).toMatchObject({ packageManager: "npm", lockfile: null });
    expect(project?.notes.join()).toContain("No lockfile");
  });

  it("starts from `main` when there is no start script", async () => {
    await write({ "package.json": { main: "src/app.js" } });
    expect((await detectNodeProject(dir))?.startCommand).toEqual(["node", "src/app.js"]);
  });

  it("falls back to server.js / index.js", async () => {
    await write({ "package.json": {}, "index.js": "" });
    expect((await detectNodeProject(dir))?.startCommand).toEqual(["node", "index.js"]);
  });

  it("does not treat a symlinked entry file as present", async () => {
    await write({ "package.json": {} });
    await fs.symlink("/etc/hosts", path.join(dir, "server.js"));
    await expect(detectNodeProject(dir)).rejects.toMatchObject({ code: ErrorCode.PROJECT_DETECTION_FAILED });
  });

  it.each([
    ["not json", "not valid JSON"],
    [{ scripts: { start: 42 } }, 'at "scripts.start"'],
    [{ packageManager: "bun@1.1.0" }, "Unsupported"],
    [{ packageManager: "pnpm@latest" }, "Unsupported"],
    [{ main: "../../etc/passwd" }, "not a safe relative path"],
    [{ main: "server.js; rm -rf /" }, "not a safe relative path"],
    [{ engines: { node: "16.x" }, scripts: { start: "x" } }, 'requires Node "16.x"'],
    [{ name: "no-start" }, 'Add a "start" script'],
  ])("rejects %j with a clear message", async (pkg, message) => {
    await write({ "package.json": pkg });
    const error = await detectNodeProject(dir).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: ErrorCode.PROJECT_DETECTION_FAILED, statusCode: 422 });
    expect((error as Error).message).toContain(message);
  });

  it("ignores a package.json that is a symlink", async () => {
    await fs.symlink("/etc/hosts", path.join(dir, "package.json"));
    expect(await detectNodeProject(dir)).toBeNull();
  });
});

describe("selectNodeMajor", () => {
  it.each([
    [undefined, 24],
    ["", 24],
    [">=18", 24],
    ["^22.11.0", 22],
    ["22.x", 22],
    ["<23", 22],
    ["20 || 22", 22],
    ["20.x", 20],
  ])("%j → Node %d", (range, major) => {
    expect(selectNodeMajor(range)).toBe(major);
  });

  it("uses the default, with a note, for an unparseable range", () => {
    const notes: string[] = [];
    expect(selectNodeMajor("lts please", notes)).toBe(DEFAULT_NODE_MAJOR);
    expect(notes).toHaveLength(1);
  });
});

describe("isSafeEntryPath", () => {
  it.each(["server.js", "./dist/index.js", "src/app.mjs", "@scope/x.js"])("accepts %s", (value) => {
    expect(isSafeEntryPath(value)).toBe(true);
  });
  it.each(["/abs/path.js", "../up.js", "a/../../b.js", "a b.js", "$(id).js", "x.js\nRUN id", ""])(
    "rejects %j",
    (value) => {
      expect(isSafeEntryPath(value)).toBe(false);
    },
  );
});
