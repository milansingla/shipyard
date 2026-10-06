import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkLockfile } from "../../src/services/detection/lockfileSync.js";
import type { PackageJson } from "../../src/services/detection/nodeProject.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-lock-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(files: Record<string, string | object>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), typeof contents === "string" ? contents : JSON.stringify(contents));
  }
}

const pkg = (value: object) => value as PackageJson;

describe("pnpm", () => {
  const workspaceLock = (webUi: string) =>
    [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    devDependencies:",
      "      turbo:",
      "        specifier: ^2.0.0",
      "        version: 2.1.0",
      "  apps/web:",
      "    dependencies:",
      "      '@acme/ui':",
      `        specifier: ${webUi}`,
      "        version: link:../../packages/ui",
      "  packages/ui: {}",
      "packages:",
      "  turbo@2.1.0: {}",
    ].join("\n");

  it("checks every workspace importer against its own package.json", async () => {
    await write({
      "pnpm-lock.yaml": workspaceLock("workspace:*"),
      "apps/web/package.json": { name: "web", dependencies: { "@acme/ui": "workspace:*" } },
      "packages/ui/package.json": { name: "@acme/ui" },
    });
    const root = pkg({ devDependencies: { turbo: "^2.0.0" } });
    expect(await checkLockfile(dir, "pnpm-lock.yaml", "pnpm", root)).toEqual({ problems: null, format: "9.0" });

    await write({ "apps/web/package.json": { name: "web", dependencies: { "@acme/ui": "workspace:^", react: "^19.0.0" } } });
    expect((await checkLockfile(dir, "pnpm-lock.yaml", "pnpm", root)).problems).toEqual([
      "@acme/ui: package.json (apps/web) wants workspace:^, the lockfile has workspace:*",
      "react@^19.0.0 is in package.json (apps/web) but not in the lockfile",
    ]);
  });

  it("a workspace package the lockfile lists but that is gone", async () => {
    await write({ "pnpm-lock.yaml": workspaceLock("workspace:*"), "apps/web/package.json": { dependencies: { "@acme/ui": "workspace:*" } } });
    expect((await checkLockfile(dir, "pnpm-lock.yaml", "pnpm", pkg({ devDependencies: { turbo: "^2.0.0" } }))).problems).toEqual([
      "the lockfile lists packages/ui, which has no package.json",
    ]);
  });

  it("lockfile v5 specifiers; overridden dependencies are not compared", async () => {
    await write({ "pnpm-lock.yaml": "lockfileVersion: 5.4\n\noverrides:\n  lodash: 4.17.21\n\nspecifiers:\n  express: ^4.18.0\n  lodash: 4.17.21\n\npackages:\n" });
    expect(await checkLockfile(dir, "pnpm-lock.yaml", "pnpm", pkg({ dependencies: { express: "^4.18.0", lodash: "^4.0.0" } }))).toEqual({ problems: null, format: "5.4" });
  });

  it("an unreadable lockfile counts as in sync (the install decides)", async () => {
    await write({ "pnpm-lock.yaml": "{{{ not yaml" });
    expect((await checkLockfile(dir, "pnpm-lock.yaml", "pnpm", pkg({ dependencies: { a: "1" } }))).problems).toBeNull();
  });
});

describe("npm", () => {
  it("like npm ci: missing or unsatisfied dependencies are stale; extra entries and non-semver specs are fine", async () => {
    await write({
      "package-lock.json": {
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/express": { version: "4.21.0" },
          "node_modules/next": { version: "14.2.28" },
          "node_modules/extra": { version: "1.0.0" },
          "node_modules/tool": { version: "1.0.0" },
        },
      },
    });
    const manifest = pkg({ dependencies: { express: "^4.18.0", next: "15.2.4", react: "^19" }, devDependencies: { tool: "github:acme/tool" } });
    expect((await checkLockfile(dir, "package-lock.json", "npm", manifest)).problems).toEqual([
      "next: package.json wants 15.2.4, the lockfile has 14.2.28",
      "react@^19 is in package.json but not in the lockfile",
    ]);
  });

  it("workspace members: nested or hoisted entries", async () => {
    await write({
      "package-lock.json": {
        lockfileVersion: 3,
        packages: { "": { workspaces: ["apps/*"] }, "apps/web": { name: "web" }, "node_modules/web": { link: true, resolved: "apps/web" }, "apps/web/node_modules/react": { version: "19.1.0" } },
      },
      "apps/web/package.json": { name: "web", dependencies: { react: "^19.0.0", lodash: "^4" } },
    });
    expect((await checkLockfile(dir, "package-lock.json", "npm", pkg({ workspaces: ["apps/*"] }))).problems).toEqual([
      "lodash@^4 is in package.json (apps/web) but not in the lockfile",
    ]);
  });

  it("lockfileVersion 1", async () => {
    await write({ "package-lock.json": { lockfileVersion: 1, dependencies: { express: { version: "4.17.1" } } } });
    expect((await checkLockfile(dir, "package-lock.json", "npm", pkg({ dependencies: { express: "^4.17.0" } }))).problems).toBeNull();
    expect((await checkLockfile(dir, "package-lock.json", "npm", pkg({ dependencies: { express: "^5.0.0" } }))).problems).toHaveLength(1);
  });
});

describe("yarn", () => {
  it("Classic: each request needs an entry", async () => {
    await write({ "yarn.lock": '# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.12.3":\n  version "7.24.0"\n\nexpress@^4.18.0:\n  version "4.21.0"\n' });
    expect(await checkLockfile(dir, "yarn.lock", "yarn", pkg({ dependencies: { express: "^4.18.0", "@babel/core": "^7.12.3" } }))).toEqual({ problems: null, format: "1" });
    expect((await checkLockfile(dir, "yarn.lock", "yarn", pkg({ dependencies: { express: "^5.0.0" } }))).problems).toEqual([
      "express@^5.0.0 (package.json) has no entry in the lockfile",
    ]);
  });

  it("Berry: npm: requests, workspace members, __metadata version", async () => {
    await write({
      "yarn.lock": '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"express@npm:^4.18.0":\n  version: 4.21.0\n\n"web@workspace:apps/web":\n  version: 0.0.0-use.local\n',
      "apps/web/package.json": { name: "web", dependencies: { react: "^19.0.0", ui: "workspace:*" } },
    });
    const result = await checkLockfile(dir, "yarn.lock", "yarn", pkg({ dependencies: { express: "^4.18.0" } }));
    expect(result).toEqual({ problems: ["react@^19.0.0 (package.json (apps/web)) has no entry in the lockfile"], format: "8" });
  });
});

describe("bun", () => {
  it("bun.lock (trailing commas allowed); bun.lockb isn't read", async () => {
    await write({ "bun.lock": '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "app",\n      "dependencies": {\n        "hono": "^4.6.0",\n      },\n    },\n  },\n}\n', "bun.lockb": "binary" });
    expect((await checkLockfile(dir, "bun.lock", "bun", pkg({ dependencies: { hono: "^4.6.0" } }))).problems).toBeNull();
    expect((await checkLockfile(dir, "bun.lock", "bun", pkg({ dependencies: { hono: "^4.7.0" } }))).problems).toEqual([
      "hono: package.json wants ^4.7.0, the lockfile has ^4.6.0",
    ]);
    expect((await checkLockfile(dir, "bun.lockb", "bun", pkg({ dependencies: { hono: "^4.7.0" } }))).problems).toBeNull();
  });
});
