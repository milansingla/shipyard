import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/lib/errors.js";
import { validateBranchName } from "../../src/services/git/branchName.js";
import { parseRepositoryUrl } from "../../src/services/git/repositoryUrl.js";

const HOSTS = ["github.com"];

describe("parseRepositoryUrl", () => {
  it.each([
    ["https://github.com/octocat/Hello-World", "octocat", "Hello-World"],
    ["https://github.com/octocat/Hello-World.git", "octocat", "Hello-World"],
    ["https://GitHub.com/octocat/hello.world/", "octocat", "hello.world"],
    ["  https://github.com/a-b/c_d  ", "a-b", "c_d"],
  ])("accepts %s", (input, owner, name) => {
    expect(parseRepositoryUrl(input, HOSTS)).toEqual({
      cloneUrl: `https://github.com/${owner}/${name}.git`,
      host: "github.com",
      owner,
      name,
    });
  });

  it.each([
    ["", "empty"],
    ["not a url", "garbage"],
    ["http://github.com/a/b", "plain http"],
    ["git@github.com:a/b.git", "ssh shorthand"],
    ["ssh://git@github.com/a/b.git", "ssh"],
    ["file:///etc/passwd", "file transport"],
    ["ext::sh -c touch% /tmp/pwned", "ext transport"],
    ["-u https://github.com/a/b", "option injection"],
    ["https://user:token@github.com/a/b", "credentials"],
    ["https://github.com:8443/a/b", "custom port"],
    ["https://gitlab.com/a/b", "host not allowed"],
    ["https://github.com.evil.com/a/b", "lookalike host"],
    ["https://github.com/a", "missing repo"],
    ["https://github.com/a/b/c", "extra path segment"],
    ["https://github.com/a/b?x=1", "query string"],
    ["https://github.com/-a/b", "owner starts with hyphen"],
    ["https://github.com/a/..", "dot-dot repo"],
    ["https://github.com/a/b%20c", "encoded space"],
  ])("rejects %s (%s)", (input) => {
    expect(() => parseRepositoryUrl(input, HOSTS)).toThrow(ValidationError);
  });

  it("respects a custom host allowlist", () => {
    expect(parseRepositoryUrl("https://gitlab.com/a/b", ["gitlab.com"]).host).toBe("gitlab.com");
  });
});

describe("validateBranchName", () => {
  it.each(["main", "feature/login", "release-1.2", "user/x_y"])("accepts %s", (branch) => {
    expect(validateBranchName(branch)).toBe(branch);
  });

  it.each([
    "",
    "-b",
    "--upload-pack=evil",
    "a..b",
    "a//b",
    "/main",
    "main/",
    "main.",
    "main.lock",
    ".hidden",
    "feature/.hidden",
    "has space",
    "semi;colon",
    "$(whoami)",
    "a".repeat(256),
  ])("rejects %j", (branch) => {
    expect(() => validateBranchName(branch)).toThrow(ValidationError);
  });
});
