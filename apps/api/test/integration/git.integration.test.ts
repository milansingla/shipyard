import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import { GitService } from "../../src/services/git/GitService.js";
import { parseRepositoryUrl } from "../../src/services/git/repositoryUrl.js";
import { silentLogger } from "../helpers/silentLogger.js";

// Requires network access to github.com.

const git = new GitService({ cloneTimeoutMs: 60_000 }, silentLogger);
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-git-it-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("GitService.clone", () => {
  it("shallow-clones a public repository and reports the commit", async () => {
    const repo = parseRepositoryUrl("https://github.com/octocat/Hello-World", ["github.com"]);
    const result = await git.clone(repo, path.join(root, "hello"), "master");

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await fs.readFile(path.join(result.path, "README"), "utf8")).toContain("Hello World");
  });

  it("fails clearly for a branch that does not exist", async () => {
    const repo = parseRepositoryUrl("https://github.com/octocat/Hello-World", ["github.com"]);
    await expect(git.clone(repo, path.join(root, "missing-branch"), "no-such-branch-xyz")).rejects.toMatchObject({
      code: ErrorCode.GIT_CLONE_FAILED,
    });
  });

  it("fails fast (no password prompt) for a repository that does not exist", async () => {
    const repo = parseRepositoryUrl("https://github.com/octocat/this-repo-does-not-exist-123", ["github.com"]);
    await expect(git.clone(repo, path.join(root, "missing-repo"), null)).rejects.toMatchObject({
      code: ErrorCode.GIT_CLONE_FAILED,
    });
  });
});

describe("GitService.readFile", () => {
  const repo = parseRepositoryUrl("https://github.com/octocat/Hello-World", ["github.com"]);

  it("reads one file at the branch head without a checkout, trying names in order", async () => {
    const file = await git.readFile(repo, "master", ["shipyard.yaml", "README"], 10_000);
    expect(file).toMatchObject({ name: "README", commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(file!.content).toContain("Hello World");
  });

  it("returns null when none of the files exist", async () => {
    expect(await git.readFile(repo, "master", ["shipyard.yaml", "shipyard.yml"], 10_000)).toBeNull();
  });

  it("refuses a file larger than the limit instead of truncating it", async () => {
    await expect(git.readFile(repo, "master", ["README"], 5)).rejects.toMatchObject({ code: ErrorCode.CONFIG_INVALID });
  });
});
