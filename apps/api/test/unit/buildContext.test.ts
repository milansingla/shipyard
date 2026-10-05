import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createContextFilter } from "../../src/services/docker/buildContext.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-ctx-"));
  for (const file of ["Dockerfile", "server.js", ".env", "node_modules/x/index.js", "node_modules/keep/a.js", ".git/HEAD"]) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), "");
  }
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function excluded(dockerignore: string | null, paths: string[], dockerfile = "Dockerfile"): Promise<string[]> {
  if (dockerignore !== null) await fs.writeFile(path.join(dir, ".dockerignore"), dockerignore);
  const ignore = await createContextFilter(dir, dockerfile);
  return paths.filter((p) => ignore(path.join(dir, p)));
}

describe("createContextFilter", () => {
  it("always excludes .git, even without a .dockerignore", async () => {
    expect(await excluded(null, [".git", ".git/HEAD", "server.js", "node_modules"])).toEqual([".git", ".git/HEAD"]);
  });

  it("applies .dockerignore patterns to files and directories", async () => {
    expect(await excluded("node_modules\n.env\n# comment\n", ["node_modules", ".env", "server.js"])).toEqual([
      "node_modules",
      ".env",
    ]);
  });

  it("never excludes the Dockerfile in use or .dockerignore itself", async () => {
    expect(await excluded("*\n", ["Dockerfile", ".dockerignore", "server.js"])).toEqual(["server.js"]);
    expect(await excluded("*\n", [".shipyard.Dockerfile"], ".shipyard.Dockerfile")).toEqual([]);
  });

  it("supports !exceptions inside excluded directories", async () => {
    const result = await excluded("node_modules\n!node_modules/keep\n", [
      "node_modules",
      "node_modules/x/index.js",
      "node_modules/keep/a.js",
    ]);
    // The directory must be walked so that keep/ can be re-included.
    expect(result).toEqual(["node_modules/x/index.js"]);
  });

  it("ignores a .dockerignore that is a symlink", async () => {
    await fs.writeFile(path.join(dir, "outside-ignore"), "server.js\n");
    await fs.symlink(path.join(dir, "outside-ignore"), path.join(dir, ".dockerignore"));
    const ignore = await createContextFilter(dir, "Dockerfile");
    expect(ignore(path.join(dir, "server.js"))).toBe(false);
  });

  it("never excludes the context root", async () => {
    const ignore = await createContextFilter(dir, "Dockerfile");
    expect(ignore(dir)).toBe(false);
  });
});
