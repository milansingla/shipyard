import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config/env.js";
import { AppError } from "../../src/lib/errors.js";

describe("parseConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = parseConfig({});
    expect(config).toMatchObject({
      env: "development",
      port: 4000,
      logLevel: "info",
      logLevelExplicit: false,
      allowedGitHosts: ["github.com"],
      publishHost: "127.0.0.1",
      workspaceDir: path.join(os.tmpdir(), "shipyard", "workspaces"),
    });
  });

  it("treats empty strings as unset (PORT= in .env)", () => {
    expect(parseConfig({ PORT: "", LOG_LEVEL: "" }).port).toBe(4000);
  });

  it("parses and normalizes values", () => {
    const config = parseConfig({
      NODE_ENV: "production",
      PORT: "8080",
      LOG_LEVEL: "debug",
      SHIPYARD_ALLOWED_GIT_HOSTS: " GitHub.com, gitlab.com ,",
      SHIPYARD_WORKSPACE_DIR: "relative/dir",
    });
    expect(config.port).toBe(8080);
    expect(config.logLevelExplicit).toBe(true);
    expect(config.allowedGitHosts).toEqual(["github.com", "gitlab.com"]);
    expect(path.isAbsolute(config.workspaceDir)).toBe(true);
  });

  it.each([
    [{ PORT: "abc" }],
    [{ PORT: "70000" }],
    [{ NODE_ENV: "staging" }],
    [{ SHIPYARD_PUBLISH_HOST: "10.0.0.5" }],
    [{ SHIPYARD_ALLOWED_GIT_HOSTS: " , " }],
  ])("rejects %j", (env) => {
    expect(() => parseConfig(env)).toThrow(AppError);
  });
});
