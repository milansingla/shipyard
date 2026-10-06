import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import {
  DEFAULT_NODE_MAJOR,
  detectNodeProject,
  isSafeEntryPath,
} from "../../src/services/detection/nodeProject.js";
import { installCommand } from "../../src/services/detection/generateDockerfile.js";
import { selectNodeVersion } from "../../src/services/detection/nodeVersion.js";

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
      packageManagerVersion: null,
      packageManagerReason: "package-lock.json → npm",
      staleLockfile: null,
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

  it("notes when several lockfiles are present", async () => {
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
    [{ packageManager: "deno@2.0.0" }, "Unsupported"],
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

describe("selectNodeVersion: engines.node", () => {
  it.each([
    [undefined, 24],
    ["", 24],
    [">=18", 24],
    ["^22.11.0", 22],
    ["22.x", 22],
    ["<23", 22],
    ["20 || 22", 22],
    ["20.x", 20],
  ])("%j → Node %d", async (range, major) => {
    expect((await selectNodeVersion([], range, [])).major).toBe(major);
  });

  it("uses the default, with a note, for an unparseable range", async () => {
    const notes: string[] = [];
    expect((await selectNodeVersion([], "lts please", notes)).major).toBe(DEFAULT_NODE_MAJOR);
    expect(notes).toHaveLength(1);
  });

  it("a range no supported Node satisfies is an error, not a silent fallback", async () => {
    await expect(selectNodeVersion([], "^16.0.0", [])).rejects.toMatchObject({ code: ErrorCode.PROJECT_DETECTION_FAILED });
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

/** A pnpm v9 lockfile for one package with these direct dependencies. */
function pnpmLock(dependencies: Record<string, string>, lockfileVersion = "9.0"): string {
  const entries = Object.entries(dependencies).map(([name, spec]) => `      ${name}:\n        specifier: ${spec}\n        version: 1.0.0`);
  return [
    `lockfileVersion: '${lockfileVersion}'`,
    "",
    "settings:",
    "  autoInstallPeers: true",
    "",
    "importers:",
    "",
    "  .:",
    ...(entries.length ? ["    dependencies:", ...entries] : []),
    "",
    "packages:",
    "",
    "  left-pad@1.0.0:",
    "    resolution: {integrity: sha512-x}",
    "",
  ].join("\n");
}

describe("package manager and version", () => {
  it("packageManager pins the exact version", async () => {
    await write({ "package.json": { packageManager: "pnpm@9.15.0", scripts: { start: "x" }, dependencies: { "left-pad": "^1.0.0" } }, "pnpm-lock.yaml": pnpmLock({ "left-pad": "^1.0.0" }) });
    expect(await detectNodeProject(dir)).toMatchObject({
      packageManager: "pnpm",
      packageManagerMajor: 9,
      packageManagerVersion: "9.15.0",
      lockfile: "pnpm-lock.yaml",
      staleLockfile: null,
    });
  });

  it("without packageManager, pnpm's version comes from lockfileVersion (never just latest)", async () => {
    await write({ "package.json": { scripts: { start: "x" } }, "pnpm-lock.yaml": pnpmLock({}) });
    expect(await detectNodeProject(dir)).toMatchObject({ packageManagerVersion: "9", packageManagerMajor: 9, packageManagerReason: "pnpm-lock.yaml (lockfileVersion 9.0) → pnpm 9" });

    await write({ "pnpm-lock.yaml": pnpmLock({}, "6.0") });
    expect((await detectNodeProject(dir))?.packageManagerVersion).toBe("8");
  });

  it("engines.pnpm picks among the versions that read the lockfile", async () => {
    await write({ "package.json": { scripts: { start: "x" }, engines: { pnpm: ">=10" } }, "pnpm-lock.yaml": pnpmLock({}) });
    expect((await detectNodeProject(dir))?.packageManagerVersion).toBe("10");
  });

  it("an unknown, newer lockfile format gets the newest pnpm, with a note", async () => {
    await write({ "package.json": { scripts: { start: "x" } }, "pnpm-lock.yaml": pnpmLock({}, "10.0") });
    const project = await detectNodeProject(dir);
    expect(project?.packageManagerVersion).toBe("latest");
    expect(project?.notes.join()).toContain("newer than Shipyard knows");
  });

  it("pnpm without a lockfile installs without --frozen-lockfile", async () => {
    await write({ "package.json": { packageManager: "pnpm@9.15.0", scripts: { start: "x" } } });
    const project = await detectNodeProject(dir);
    expect(project).toMatchObject({ packageManager: "pnpm", lockfile: null });
    expect(installCommand(project!)).toBe("pnpm install");
  });

  it("yarn: Classic from a v1 lockfile; Berry's major from __metadata, installed --immutable", async () => {
    await write({ "package.json": { scripts: { start: "x" } }, "yarn.lock": "# yarn lockfile v1\n\n" });
    expect(await detectNodeProject(dir)).toMatchObject({ packageManager: "yarn", packageManagerVersion: "1", packageManagerMajor: 1 });

    await write({ "yarn.lock": "__metadata:\n  version: 8\n  cacheKey: 10c0\n" });
    const berry = await detectNodeProject(dir);
    expect(berry).toMatchObject({ packageManager: "yarn", packageManagerVersion: "4", packageManagerMajor: 4 });
    expect(installCommand(berry!)).toBe("yarn install --immutable");
  });

  it("bun: bun.lock, bun install --frozen-lockfile", async () => {
    await write({ "package.json": { scripts: { start: "x" } }, "bun.lock": '{ "lockfileVersion": 1, "workspaces": { "": { "name": "x" } } }' });
    const project = await detectNodeProject(dir);
    expect(project).toMatchObject({ packageManager: "bun", lockfile: "bun.lock" });
    expect(installCommand(project!)).toBe("bun install --frozen-lockfile");
  });

  it("reports a lockfile that no longer matches package.json (the install would refuse it)", async () => {
    await write({
      "package.json": { scripts: { start: "x" }, dependencies: { firebase: "10.7.1", nodemailer: "6.9.8" } },
      "pnpm-lock.yaml": pnpmLock({ firebase: "latest", nodemailer: "6.9.8", localtunnel: "^2.0.2" }),
    });
    const project = await detectNodeProject(dir);
    expect(project?.lockfile).toBe("pnpm-lock.yaml");
    expect(project?.staleLockfile).toEqual([
      "firebase: package.json wants 10.7.1, the lockfile has latest",
      "localtunnel@^2.0.2 is in the lockfile but no longer in package.json",
    ]);
    // Still a frozen install: Shipyard never relaxes it to get past an outdated lockfile.
    expect(installCommand(project!)).toBe("pnpm install --frozen-lockfile");
  });

  it("with several lockfiles, the one that matches package.json wins over a stale one", async () => {
    await write({
      "package.json": { scripts: { start: "x" }, dependencies: { "left-pad": "^1.3.0" } },
      "pnpm-lock.yaml": pnpmLock({ "left-pad": "^1.0.0" }),
      "package-lock.json": { lockfileVersion: 3, packages: { "": { dependencies: { "left-pad": "^1.3.0" } }, "node_modules/left-pad": { version: "1.3.0" } } },
    });
    const project = await detectNodeProject(dir);
    expect(project).toMatchObject({ packageManager: "npm", lockfile: "package-lock.json", staleLockfile: null });
    expect(project?.notes.join()).toContain("pnpm-lock.yaml is out of date with package.json, so npm (package-lock.json) is used");
  });

  it("several lockfiles, all stale: the priority one, reported as stale", async () => {
    await write({
      "package.json": { scripts: { start: "x" }, dependencies: { next: "15.2.4" } },
      "pnpm-lock.yaml": pnpmLock({ next: "^14.2.28" }),
      "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "node_modules/next": { version: "14.2.28" } } },
    });
    const project = await detectNodeProject(dir);
    expect(project?.packageManager).toBe("pnpm");
    expect(project?.staleLockfile).toEqual(["next: package.json wants 15.2.4, the lockfile has ^14.2.28"]);
  });

  it("a packageManager that doesn't match the lockfile's format is noted", async () => {
    await write({ "package.json": { packageManager: "pnpm@8.15.9", scripts: { start: "x" } }, "pnpm-lock.yaml": pnpmLock({}) });
    expect((await detectNodeProject(dir))?.notes.join()).toContain("was written by pnpm 9/10/11/12");
  });
});

describe("Node version", () => {
  it.each([
    [{ ".nvmrc": "22\n" }, 22],
    [{ ".nvmrc": "v20.11.1" }, 20],
    [{ ".node-version": "22.12.0", ".nvmrc": "20" }, 22],
    [{ ".nvmrc": "lts/jod" }, 22],
    [{ ".nvmrc": "lts/*" }, 24],
    [{ ".tool-versions": "python 3.12.1\nnodejs 20.18.0\n" }, 20],
  ])("%j → Node %d", async (files, major) => {
    await write({ "package.json": { scripts: { start: "x" } }, ...files });
    expect((await detectNodeProject(dir))?.nodeMajor).toBe(major);
  });

  it("an unsupported version gets the nearest supported one, with a note", async () => {
    await write({ "package.json": { scripts: { start: "x" } }, ".nvmrc": "18" });
    const project = await detectNodeProject(dir);
    expect(project?.nodeMajor).toBe(20);
    expect(project?.notes.join()).toContain(".nvmrc asks for Node 18");
  });

  it("a version file that contradicts engines.node loses to engines, with a note", async () => {
    await write({ "package.json": { scripts: { start: "x" }, engines: { node: ">=22" } }, ".nvmrc": "20" });
    const project = await detectNodeProject(dir);
    expect(project?.nodeMajor).toBe(24);
    expect(project?.notes.join()).toContain('.nvmrc asks for Node 20, but engines.node is ">=22"');
  });
});
