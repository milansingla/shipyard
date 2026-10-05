import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/errors.js";
import { WorkspaceService } from "../../src/services/workspace/WorkspaceService.js";

describe("WorkspaceService", () => {
  let root: string;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-ws-")), "workspaces");
    workspace = new WorkspaceService(root);
  });
  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it("prepares a per-deployment path inside the root and cleans it up", async () => {
    const dir = await workspace.prepare("deploy-1");
    expect(dir).toBe(path.join(root, "deploy-1"));

    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "file.txt"), "x");
    await workspace.cleanup(dir);

    await expect(fs.stat(dir)).rejects.toThrow();
    await expect(fs.stat(root)).resolves.toBeDefined();
  });

  it.each(["../escape", "a/b", "..", "/etc"])("refuses ids that escape the root: %j", async (id) => {
    await expect(workspace.prepare(id)).rejects.toThrow(AppError);
  });

  it("refuses to clean up paths outside the root", async () => {
    await expect(workspace.cleanup(path.dirname(root))).rejects.toThrow(AppError);
    await expect(workspace.cleanup(root)).rejects.toThrow(AppError);
  });
});
