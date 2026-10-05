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

describe("parseConfig: URLs and GitHub sign-in", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const github = {
    GITHUB_CLIENT_ID: "Iv1.abc",
    GITHUB_CLIENT_SECRET: "shh",
    SHIPYARD_SECRET_KEY: KEY,
    SHIPYARD_ALLOWED_GITHUB_USERS: " Alice, bob ,",
  };

  it("defaults: no GitHub, public URL from PORT, insecure cookies over http", () => {
    const config = parseConfig({ PORT: "4100" });
    expect(config.publicUrl).toBe("http://localhost:4100");
    expect(config.appUrl).toBe("http://localhost:4100");
    expect(config.auth).toMatchObject({ github: null, secretKey: null, secureCookies: false });
    expect(config.auth.sessionTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("enables GitHub sign-in when client id, secret and key are all set", () => {
    const config = parseConfig({
      ...github,
      SHIPYARD_PUBLIC_URL: "https://shipyard.example.com/",
      SHIPYARD_APP_URL: "https://app.example.com",
    });
    expect(config.auth.github).toEqual({ clientId: "Iv1.abc", clientSecret: "shh" });
    expect(config.auth.allowedUsers).toEqual(["alice", "bob"]);
    expect(config.auth.secretKey?.length).toBe(32);
    expect(config.publicUrl).toBe("https://shipyard.example.com");
    expect(config.auth.secureCookies).toBe(true);
  });

  it.each([
    [{ GITHUB_CLIENT_ID: "x" }, "both"],
    [{ GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y" }, "SHIPYARD_SECRET_KEY"],
    [{ SHIPYARD_SECRET_KEY: "too-short" }, "32 bytes"],
    [{ ...github, SHIPYARD_ALLOWED_GITHUB_USERS: "" }, "SHIPYARD_ALLOWED_GITHUB_USERS"],
    [{ ...github, SHIPYARD_ALLOWED_GITHUB_USERS: " , " }, "SHIPYARD_ALLOWED_GITHUB_USERS"],
    [{ SHIPYARD_PUBLIC_URL: "ftp://x" }, "SHIPYARD_PUBLIC_URL"],
  ])("rejects %j", (env, message) => {
    expect(() => parseConfig(env)).toThrow(message);
  });

  it('accepts "*" to allow any GitHub account, explicitly', () => {
    expect(parseConfig({ ...github, SHIPYARD_ALLOWED_GITHUB_USERS: "*" }).auth.allowedUsers).toBe("*");
  });

  it("never echoes an invalid secret key", () => {
    expect(() => parseConfig({ SHIPYARD_SECRET_KEY: "my-leaked-value" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("my-leaked-value") }),
    );
  });
});

describe("parseConfig: Traefik routing", () => {
  it("is off by default: each deployment is reached on its own port", () => {
    expect(parseConfig({}).routing).toBeNull();
  });

  it("routes <slug>.<domain> through Traefik on port 80, with routes kept in the data dir", () => {
    const config = parseConfig({ SHIPYARD_PUBLIC_DOMAIN: " Apps.Example.com ", SHIPYARD_DATA_DIR: "/srv/shipyard" });
    expect(config.routing).toEqual({
      domain: "apps.example.com",
      httpPort: 80,
      routesDir: path.join("/srv/shipyard", "traefik"),
    });
    expect(parseConfig({ SHIPYARD_PUBLIC_DOMAIN: "localhost", SHIPYARD_HTTP_PORT: "8000" }).routing?.httpPort).toBe(8000);
  });

  it.each(["http://localhost", "localhost:80", "*.example.com", ".localhost", "exa mple.com", "a`b"])(
    "rejects the domain %j",
    (domain) => {
      expect(() => parseConfig({ SHIPYARD_PUBLIC_DOMAIN: domain })).toThrow("SHIPYARD_PUBLIC_DOMAIN");
    },
  );

  it("refuses to also publish apps on every interface, bypassing Traefik", () => {
    expect(() => parseConfig({ SHIPYARD_PUBLIC_DOMAIN: "localhost", SHIPYARD_PUBLISH_HOST: "0.0.0.0" })).toThrow(
      "SHIPYARD_PUBLISH_HOST must be 127.0.0.1",
    );
  });
});
