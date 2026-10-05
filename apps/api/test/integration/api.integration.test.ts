import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/db/prisma.js";
import { SecretBox } from "../../src/lib/secretBox.js";
import { sessionCookieName } from "../../src/middleware/authenticate.js";
import { AuthService } from "../../src/modules/auth/AuthService.js";
import { BuildLogStore } from "../../src/modules/deployments/BuildLogStore.js";
import { DeploymentService, type EngineLike } from "../../src/modules/deployments/DeploymentService.js";
import { EnvironmentService } from "../../src/modules/environment/EnvironmentService.js";
import { ProjectService } from "../../src/modules/projects/ProjectService.js";
import { signGitHubPayload } from "../../src/modules/webhooks/signature.js";
import { WebhookService } from "../../src/modules/webhooks/WebhookService.js";
import { DeploymentStatus as S } from "../../src/services/deployment/status.js";
import type { DeploymentJob, DeploymentState } from "../../src/services/deployment/types.js";
import { GitHubClient } from "../../src/services/github/GitHubClient.js";
import type { Router } from "../../src/services/routing/Router.js";
import { createTestPrisma, resetTables } from "../helpers/db.js";
import { silentLogger } from "../helpers/silentLogger.js";

// The HTTP API end to end against real PostgreSQL: GitHub sign-in (against a
// local fake GitHub that really checks PKCE), sessions, and per-user
// authorization of every project/deployment endpoint. Docker and `git ls-remote`
// are faked — they are covered by deployment.integration.test.ts and
// git.integration.test.ts; this suite is about who may do what.

interface FakeGitHubUser {
  id: number;
  login: string;
}

/** Just enough of github.com + api.github.com for the OAuth web flow. */
class FakeGitHub {
  readonly server = http.createServer((req, res) => void this.handle(req, res));
  private readonly codes = new Map<string, { user: FakeGitHubUser; challenge: string }>();
  private readonly tokens = new Map<string, FakeGitHubUser>();

  /** What github.com does after the user clicks "Authorize": remember the PKCE challenge, issue a code. */
  issueCode(user: FakeGitHubUser, challenge: string): string {
    const code = randomUUID();
    this.codes.set(code, { user, challenge });
    return code;
  }

  revokeAll(): void {
    this.tokens.clear();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };

    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as { client_secret: string; code: string; code_verifier: string };
      const grant = this.codes.get(body.code);
      this.codes.delete(body.code); // single use, like GitHub
      const verifierMatches =
        grant !== undefined && createHash("sha256").update(body.code_verifier).digest("base64url") === grant.challenge;
      if (body.client_secret !== "test-secret" || !grant || !verifierMatches) {
        return send(200, { error: "bad_verification_code" });
      }
      const token = `gho_${randomUUID()}`;
      this.tokens.set(token, grant.user);
      return send(200, { access_token: token, token_type: "bearer", scope: "read:user" });
    }

    const user = this.tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!user) return send(401, { message: "Bad credentials" });

    if (url.pathname === "/user") return send(200, { id: user.id, login: user.login, name: null, avatar_url: null });
    if (url.pathname === "/user/repos") {
      return send(200, [
        repo(user.login, "public-app", false),
        repo(user.login, "secret-app", true),
      ]);
    }
    const branches = /^\/repos\/([^/]+)\/([^/]+)\/branches$/.exec(url.pathname);
    if (branches) return send(200, [{ name: "main" }, { name: "develop" }]);
    send(404, { message: "Not Found" });
  }
}

function repo(owner: string, name: string, isPrivate: boolean) {
  return {
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
    private: isPrivate,
    default_branch: "main",
    html_url: `https://github.com/${owner}/${name}`,
    updated_at: "2026-10-01T00:00:00Z",
  };
}

/** While set, every fake deployment pauses after CLONING until it resolves. */
let holdRuns: Promise<void> | null = null;

/** The route table as the router would have it: hostname label → deployment id. */
const liveRoutes = new Map<string, string>();

/** Behaves like TraefikRouter, minus Traefik: switching is instant. */
const fakeRouter: Router = {
  network: null,
  urlFor: (name) => `http://${name}.localhost`,
  async activate(target) {
    liveRoutes.set(target.name, target.deploymentId);
  },
  async deactivate(name, deploymentId) {
    if (liveRoutes.get(name) === deploymentId) liveRoutes.delete(name);
  },
  async sync(targets) {
    liveRoutes.clear();
    for (const target of targets) liveRoutes.set(target.name, target.deploymentId);
  },
};

/** The last job the fake engine was asked to run (to see what it would hand to Docker). */
let lastJob: DeploymentJob | null = null;

/** Walks a deployment to RUNNING instantly, without Docker, routing it like the real engine. */
const fakeEngine: EngineLike = {
  async run(job, observer = {}) {
    lastJob = job;
    const state: DeploymentState = {
      id: job.id,
      status: S.QUEUED,
      branch: job.branch,
      commitSha: "c".repeat(40),
      imageName: `shipyard/${job.name}:x`,
      containerName: `shipyard-${job.name}-x`,
      containerId: `container-${job.id}`,
      containerPort: 3000,
      hostPort: 49_999,
      deploymentUrl: null,
      errorMessage: null,
      failedStage: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    for (const status of [S.CLONING, S.DETECTING, S.BUILDING, S.STARTING, S.HEALTH_CHECKING, S.HEALTHY, S.ROUTING, S.RUNNING]) {
      if (status === S.RUNNING) {
        await fakeRouter.activate({ name: job.name, deploymentId: job.id, containerName: state.containerName, containerPort: 3000 });
        state.deploymentUrl = fakeRouter.urlFor(job.name, 49_999);
      }
      const previous = state.status;
      state.status = status;
      await observer.onStatusChange?.(state, previous);
      if (status === S.CLONING && holdRuns) await holdRuns;
    }
    return state;
  },
  async stop() {
    return { containerName: "x", status: S.STOPPED, hostPort: null, deploymentUrl: null };
  },
  async restart(containerId, routeName, onStage = async () => {}) {
    for (const stage of [S.HEALTH_CHECKING, S.HEALTHY, S.ROUTING]) await onStage(stage);
    const deploymentId = containerId.replace(/^container-/, "");
    await fakeRouter.activate({ name: routeName, deploymentId, containerName: "x", containerPort: 3000 });
    return { containerName: "x", status: S.RUNNING, hostPort: 49_998, deploymentUrl: fakeRouter.urlFor(routeName, 49_998) };
  },
  async getLogs() {
    return [{ stream: "stdout" as const, text: "hello\n" }];
  },
  async destroy() {},
  async inspect() {
    return { running: true, exitCode: null, hostPort: 49_999 };
  },
  async ensureRoutable() {},
};

const APP_URL = "http://localhost:3000";
const WEBHOOK_SECRET = "integration-test-webhook-secret";
const SESSION_COOKIE = sessionCookieName(false);
const ALICE = { id: 1001, login: "alice" };
const BOB = { id: 2002, login: "bob" };
const MALLORY = { id: 3003, login: "mallory" };

let prisma: PrismaClient;
let fakeGitHub: FakeGitHub;
let apiServer: http.Server;
let api: string;
let dataDir: string;
let deployments: DeploymentService;
let environment: EnvironmentService;

beforeAll(async () => {
  prisma = createTestPrisma();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-api-it-"));

  fakeGitHub = new FakeGitHub();
  const githubBase = await listen(fakeGitHub.server);

  // Listen first: the OAuth redirect URI must contain the real port.
  apiServer = http.createServer();
  api = await listen(apiServer);

  const github = new GitHubClient({
    clientId: "test-client",
    clientSecret: "test-secret",
    oauthBaseUrl: githubBase,
    apiBaseUrl: githubBase,
  });
  const auth = new AuthService({
    prisma,
    github,
    secretBox: new SecretBox(Buffer.alloc(32, 5)), // the same key as `environment`, as in bootstrap.ts
    redirectUri: `${api}/api/auth/github/callback`,
    sessionTtlMs: 60 * 60 * 1000,
    // Matched case-insensitively; "alice-renamed" is used by the rename test.
    allowedUsers: ["alice", "bob", "alice-renamed"],
    logger: silentLogger,
  });
  const secretBox = new SecretBox(Buffer.alloc(32, 5));
  environment = new EnvironmentService({ prisma, secretBox, logger: silentLogger });
  deployments = new DeploymentService({
    prisma,
    engine: fakeEngine,
    environment,
    router: fakeRouter,
    buildLogs: new BuildLogStore(dataDir),
    allowedGitHosts: ["github.com"],
    logger: silentLogger,
  });
  const projects = new ProjectService({
    prisma,
    git: { resolveBranch: async (_repo, branch) => branch ?? "main" },
    deployments,
    allowedGitHosts: ["github.com"],
    logger: silentLogger,
  });

  apiServer.on(
    "request",
    createApp({
      docker: { ping: async () => true },
      projects,
      deployments,
      environment,
      auth: { service: auth, github, sessionCookie: SESSION_COOKIE, secureCookies: false, appUrl: APP_URL },
      webhooks: {
        service: new WebhookService({ prisma, deployments, logger: silentLogger }),
        secret: WEBHOOK_SECRET,
      },
      allowedOrigins: [api, APP_URL],
      logger: silentLogger,
      exposeInternalErrors: true,
    }),
  );
});

beforeEach(async () => {
  holdRuns = null;
  await deployments.waitForIdle();
  liveRoutes.clear();
  await resetTables(prisma);
  await prisma.webhookDelivery.deleteMany();
});

afterAll(async () => {
  await deployments.waitForIdle();
  await new Promise((resolve) => apiServer.close(resolve));
  await new Promise((resolve) => fakeGitHub.server.close(resolve));
  await prisma.$disconnect();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function cookieFrom(res: Response, name: string): string {
  const header = res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) throw new Error(`No ${name} cookie in response`);
  return header.split(";")[0]!;
}

/** Starts sign-in, plays GitHub's part, completes the callback. Returns the session cookie. */
async function signIn(user: FakeGitHubUser, tamper: { state?: string; dropLoginCookie?: boolean } = {}) {
  const login = await fetch(`${api}/api/auth/github/login`, { redirect: "manual" });
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.get("location")!);
  const code = fakeGitHub.issueCode(user, authorize.searchParams.get("code_challenge")!);
  const state = tamper.state ?? authorize.searchParams.get("state")!;

  const callback = await fetch(`${api}/api/auth/github/callback?code=${code}&state=${state}`, {
    redirect: "manual",
    headers: tamper.dropLoginCookie ? {} : { cookie: cookieFrom(login, "shipyard_oauth") },
  });
  return callback;
}

async function sessionFor(user: FakeGitHubUser): Promise<string> {
  const callback = await signIn(user);
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${APP_URL}/`);
  return cookieFrom(callback, SESSION_COOKIE);
}

async function call(cookie: string | null, method: string, route: string, body?: unknown) {
  const res = await fetch(`${api}${route}`, {
    method,
    headers: {
      ...(cookie && { cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

describe("GitHub sign-in", () => {
  it("signs in, sets an httpOnly session cookie, and exposes the user without any token", async () => {
    const callback = await signIn(ALICE);
    const setCookie = callback.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const me = await call(cookieFrom(callback, SESSION_COOKIE), "GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ data: { id: expect.any(String), githubId: "1001", login: "alice", name: null, avatarUrl: null } });
    expect(JSON.stringify(me.body)).not.toContain("gho_");
  });

  it("stores the GitHub token encrypted and only a hash of the session token", async () => {
    const cookie = await sessionFor(ALICE);
    const rawSession = cookie.split("=")[1]!;

    const user = await prisma.user.findUniqueOrThrow({ where: { githubId: 1001n } });
    expect(user.githubAccessToken.startsWith("v1:")).toBe(true);
    expect(user.githubAccessToken).not.toContain("gho_");

    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).not.toBe(rawSession);
    expect(sessions[0]!.id).toBe(createHash("sha256").update(rawSession).digest("hex"));
  });

  it("signing in again updates the same user (e.g. renamed login), not a duplicate", async () => {
    await sessionFor(ALICE);
    await sessionFor({ ...ALICE, login: "alice-renamed" });
    const users = await prisma.user.findMany();
    expect(users.map((u) => u.login)).toEqual(["alice-renamed"]);
  });

  it("refuses GitHub accounts not in SHIPYARD_ALLOWED_GITHUB_USERS, creating nothing", async () => {
    const callback = await signIn(MALLORY);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${APP_URL}/?signin_error=FORBIDDEN`);
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it("matches the allowlist case-insensitively", async () => {
    expect((await signIn({ ...ALICE, login: "ALICE" })).status).toBe(302);
  });

  it("ends existing sessions of a user removed from the allowlist", async () => {
    const cookie = await sessionFor(BOB);
    // Simulates the admin removing "bob" and restarting: the user row stays, the login no longer matches.
    await prisma.user.updateMany({ where: { login: "bob" }, data: { login: "bob-not-allowed" } });
    expect((await call(cookie, "GET", "/api/auth/me")).status).toBe(401);
  });

  it("rejects a callback whose state doesn't match (login CSRF)", async () => {
    const callback = await signIn(ALICE, { state: "A".repeat(43) });
    expect(callback.headers.get("location")).toBe(`${APP_URL}/?signin_error=OAUTH_FAILED`);
    expect(await prisma.session.count()).toBe(0);
  });

  it("rejects a callback from a browser that didn't start the sign-in", async () => {
    const callback = await signIn(ALICE, { dropLoginCookie: true });
    expect(callback.headers.get("location")).toBe(`${APP_URL}/?signin_error=OAUTH_FAILED`);
    expect(await prisma.user.count()).toBe(0);
  });

  it("sends a cancelled sign-in back to the dashboard with a code it can explain", async () => {
    const res = await fetch(`${api}/api/auth/github/callback?error=access_denied`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/?signin_error=OAUTH_FAILED`);
  });

  it("logout ends the session server-side", async () => {
    const cookie = await sessionFor(ALICE);
    expect((await call(cookie, "POST", "/api/auth/logout")).status).toBe(204);
    expect((await call(cookie, "GET", "/api/auth/me")).status).toBe(401);
  });

  it("expired sessions are rejected and removed", async () => {
    const cookie = await sessionFor(ALICE);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(cookie, "GET", "/api/auth/me")).status).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it.each(["garbage", "", "x".repeat(43)])("an invalid session cookie %j is just 'signed out'", async (value) => {
    expect((await call(`${SESSION_COOKIE}=${value}`, "GET", "/api/auth/me")).status).toBe(401);
  });
});

describe("authorization", () => {
  it("requires a session for every project and deployment endpoint", async () => {
    const id = randomUUID();
    for (const [method, route] of [
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["GET", `/api/projects/${id}`],
      ["DELETE", `/api/projects/${id}`],
      ["POST", `/api/projects/${id}/deploy`],
      ["GET", `/api/projects/${id}/deployments`],
      ["GET", `/api/deployments/${id}`],
      ["GET", `/api/deployments/${id}/logs`],
      ["POST", `/api/deployments/${id}/stop`],
      ["POST", `/api/deployments/${id}/restart`],
      ["POST", `/api/deployments/${id}/redeploy`],
      ["GET", "/api/github/repos"],
    ] as const) {
      const res = await call(null, method, route);
      expect({ route: `${method} ${route}`, status: res.status }).toEqual({ route: `${method} ${route}`, status: 401 });
    }
  });

  it("users only ever see and act on their own projects and deployments (others get 404)", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);

    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/alice/app" });
    expect(created.status).toBe(201);
    const projectId = created.body!.data.id as string;

    const deployed = await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    expect(deployed.status).toBe(202);
    const deploymentId = deployed.body!.data.id as string;
    await deployments.waitForIdle();

    // Alice sees her own things.
    expect((await call(alice, "GET", "/api/projects")).body!.data).toHaveLength(1);
    expect((await call(alice, "GET", `/api/deployments/${deploymentId}`)).body!.data.status).toBe(S.RUNNING);

    // Bob sees nothing, and can't tell whether Alice's ids exist.
    expect((await call(bob, "GET", "/api/projects")).body!.data).toEqual([]);
    for (const [method, route] of [
      ["GET", `/api/projects/${projectId}`],
      ["POST", `/api/projects/${projectId}/deploy`],
      ["GET", `/api/projects/${projectId}/deployments`],
      ["DELETE", `/api/projects/${projectId}`],
      ["GET", `/api/deployments/${deploymentId}`],
      ["GET", `/api/deployments/${deploymentId}/logs?type=runtime`],
      ["POST", `/api/deployments/${deploymentId}/stop`],
      ["POST", `/api/deployments/${deploymentId}/restart`],
      ["POST", `/api/deployments/${deploymentId}/redeploy`],
    ] as const) {
      const res = await call(bob, method, route);
      expect({ route: `${method} ${route}`, status: res.status }).toEqual({ route: `${method} ${route}`, status: 404 });
    }

    // Nothing Bob tried had any effect.
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.deployment.count()).toBe(1);
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } })).status).toBe(S.RUNNING);

    // Alice can still manage it.
    expect((await call(alice, "POST", `/api/deployments/${deploymentId}/stop`)).body!.data.status).toBe(S.STOPPED);
    expect((await call(alice, "DELETE", `/api/projects/${projectId}`)).status).toBe(204);
  });

  it("refuses state-changing requests from other sites, even with a valid session", async () => {
    const alice = await sessionFor(ALICE);
    const res = await fetch(`${api}/api/projects`, {
      method: "POST",
      headers: { cookie: alice, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/alice/app" }),
    });
    expect(res.status).toBe(403);
    expect(await prisma.project.count()).toBe(0);

    const fromDashboard = await fetch(`${api}/api/projects`, {
      method: "POST",
      headers: { cookie: alice, origin: APP_URL, "content-type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/alice/app" }),
    });
    expect(fromDashboard.status).toBe(201);
  });
});

describe("repository selection", () => {
  it("lists the user's repositories, marking private ones as not deployable", async () => {
    const alice = await sessionFor(ALICE);
    const res = await call(alice, "GET", "/api/github/repos");
    expect(res.status).toBe(200);
    expect(res.body!.data.items.map((r: Record<string, unknown>) => [r.fullName, r.deployable, r.repositoryUrl])).toEqual([
      ["alice/public-app", true, "https://github.com/alice/public-app"],
      ["alice/secret-app", false, "https://github.com/alice/secret-app"],
    ]);
  });

  it("lists branches, validating owner and repo", async () => {
    const alice = await sessionFor(ALICE);
    expect((await call(alice, "GET", "/api/github/repos/alice/public-app/branches")).body).toEqual({
      data: { items: ["main", "develop"], hasNextPage: false },
    });
    expect((await call(alice, "GET", "/api/github/repos/-bad/x/branches")).status).toBe(400);
  });

  it("asks the user to sign in again when GitHub revokes the token", async () => {
    const alice = await sessionFor(ALICE);
    fakeGitHub.revokeAll();
    const res = await call(alice, "GET", "/api/github/repos");
    expect(res.status).toBe(401);
    expect(res.body!.error.message).toContain("Sign in again");
  });
});

describe("GitHub push webhooks", () => {
  function pushPayload(owner: string, name: string, ref: string, extra: Record<string, unknown> = {}) {
    return {
      ref,
      after: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
      deleted: false,
      repository: { name, owner: { login: owner, name: owner } },
      ...extra,
    };
  }

  async function deliver(
    payload: unknown,
    options: { event?: string; delivery?: string; secret?: string; contentType?: string } = {},
  ) {
    const body = JSON.stringify(payload);
    const res = await fetch(`${api}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/json",
        "x-github-event": options.event ?? "push",
        "x-github-delivery": options.delivery ?? randomUUID(),
        "x-hub-signature-256": signGitHubPayload(options.secret ?? WEBHOOK_SECRET, body),
      },
      body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  async function createProject(cookie: string, repositoryUrl: string, branch: string, name?: string) {
    const res = await call(cookie, "POST", "/api/projects", { repositoryUrl, branch, name });
    expect(res.status).toBe(201);
    return res.body!.data.id as string;
  }

  it("answers GitHub's ping", async () => {
    const res = await deliver({ zen: "Design for failure." }, { event: "ping" });
    expect(res).toEqual({ status: 200, body: { data: { duplicate: false, outcome: "pong" } } });
  });

  it("deploys every project tracking the pushed repository and branch, and nothing else", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const main = await createProject(alice, "https://github.com/Acme/Shop", "main", "shop");
    const otherBranch = await createProject(alice, "https://github.com/acme/shop", "develop", "shop-dev");
    const otherRepo = await createProject(alice, "https://github.com/acme/blog", "main", "blog");
    const bobsCopy = await createProject(bob, "https://github.com/acme/shop", "main", "bobs-shop");

    // Lower-case in the payload, mixed case in the project: GitHub names are case-insensitive.
    const res = await deliver(pushPayload("acme", "shop", "refs/heads/main"));
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("7fd1a60 on main: deploying shop; deploying bobs-shop");
    await deployments.waitForIdle();

    const triggered = await prisma.deployment.findMany({ select: { projectId: true, trigger: true, status: true } });
    expect(triggered.sort((a, b) => a.projectId.localeCompare(b.projectId))).toEqual(
      [main, bobsCopy].sort().map((projectId) => ({ projectId, trigger: "PUSH", status: S.RUNNING })),
    );
    expect(triggered.some((d) => d.projectId === otherBranch || d.projectId === otherRepo)).toBe(false);
  });

  it("refuses a delivery with a wrong signature and does nothing", async () => {
    const alice = await sessionFor(ALICE);
    await createProject(alice, "https://github.com/acme/shop", "main");
    const res = await deliver(pushPayload("acme", "shop", "refs/heads/main"), { secret: "an-attacker-guessed-this-secret" });
    expect(res.status).toBe(401);
    expect(await prisma.deployment.count()).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("handles a redelivered webhook once", async () => {
    const alice = await sessionFor(ALICE);
    await createProject(alice, "https://github.com/acme/shop", "main");
    const delivery = randomUUID();

    const first = await deliver(pushPayload("acme", "shop", "refs/heads/main"), { delivery });
    await deployments.waitForIdle();
    const second = await deliver(pushPayload("acme", "shop", "refs/heads/main"), { delivery });

    expect(first.body.data.duplicate).toBe(false);
    expect(second.body.data).toEqual({ duplicate: true, outcome: "already handled" });
    expect(await prisma.deployment.count()).toBe(1);
  });

  it.each([
    ["a tag push", pushPayload("acme", "shop", "refs/tags/v1.0.0"), "push", "not a branch"],
    ["a deleted branch", pushPayload("acme", "shop", "refs/heads/main", { deleted: true }), "push", "branch deleted"],
    ["an unknown repository", pushPayload("acme", "unknown", "refs/heads/main"), "push", "no project deploys"],
    ["another event type", { action: "opened" }, "pull_request", "only acts on push"],
  ])("ignores %s", async (_case, payload, event, reason) => {
    const alice = await sessionFor(ALICE);
    await createProject(alice, "https://github.com/acme/shop", "main");
    const res = await deliver(payload, { event });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toContain(reason);
    expect(await prisma.deployment.count()).toBe(0);
  });

  it("queues a push that arrives mid-deploy and deploys it once the current deploy ends", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await createProject(alice, "https://github.com/acme/shop", "main");

    let release!: () => void;
    holdRuns = new Promise((resolve) => (release = resolve));
    expect((await call(alice, "POST", `/api/projects/${projectId}/deploy`)).status).toBe(202);

    // Three quick pushes while the manual deploy is running…
    for (let i = 0; i < 3; i += 1) {
      const res = await deliver(pushPayload("acme", "shop", "refs/heads/main"));
      expect(res.body.data.outcome).toContain("queued shop");
    }
    holdRuns = null;
    release();
    await deployments.waitForIdle();

    // …cost exactly one follow-up deployment, triggered by push.
    const history = await prisma.deployment.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    expect(history.map((d) => [d.trigger, d.status])).toEqual([
      ["MANUAL", S.STOPPED], // retired when the newer one went live
      ["PUSH", S.RUNNING],
    ]);
  });

  it("rejects form-encoded deliveries with instructions", async () => {
    const res = await deliver({}, { contentType: "application/x-www-form-urlencoded" });
    expect(res.status).toBe(415);
    expect(res.body.error.message).toContain("application/json");
  });
});

describe("routing (zero-downtime redeploys)", () => {
  async function deployAndWait(cookie: string, projectId: string): Promise<string> {
    const res = await call(cookie, "POST", `/api/projects/${projectId}/deploy`);
    expect(res.status).toBe(202);
    await deployments.waitForIdle();
    return res.body!.data.id as string;
  }

  it("moves the project's hostname to each new deployment; retiring the old one never takes it away", async () => {
    const alice = await sessionFor(ALICE);
    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/shop" });
    const projectId = created.body!.data.id as string;

    const first = await deployAndWait(alice, projectId);
    expect(liveRoutes).toEqual(new Map([["shop", first]]));

    const second = await deployAndWait(alice, projectId);
    expect(liveRoutes).toEqual(new Map([["shop", second]]));
    const firstAfter = await call(alice, "GET", `/api/deployments/${first}`);
    expect(firstAfter.body!.data).toMatchObject({ status: S.STOPPED, deploymentUrl: null });
    expect((await call(alice, "GET", `/api/deployments/${second}`)).body!.data.deploymentUrl).toBe("http://shop.localhost");

    // Rollback: restarting the older deployment takes the hostname back, then retires the newer one.
    expect((await call(alice, "POST", `/api/deployments/${first}/restart`)).status).toBe(200);
    expect(liveRoutes).toEqual(new Map([["shop", first]]));
    expect((await call(alice, "GET", `/api/deployments/${second}`)).body!.data.status).toBe(S.STOPPED);

    // Stopping the live deployment takes it off the hostname.
    await call(alice, "POST", `/api/deployments/${first}/stop`);
    expect(liveRoutes.size).toBe(0);
  });

  it("deleting a project removes its route", async () => {
    const alice = await sessionFor(ALICE);
    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/blog" });
    const projectId = created.body!.data.id as string;
    await deployAndWait(alice, projectId);
    expect(liveRoutes.has("blog")).toBe(true);

    expect((await call(alice, "DELETE", `/api/projects/${projectId}`)).status).toBe(204);
    expect(liveRoutes.has("blog")).toBe(false);
  });

  it("at startup, rebuilds the route table from the database's RUNNING deployments", async () => {
    const alice = await sessionFor(ALICE);
    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/docs" });
    const live = await deployAndWait(alice, created.body!.data.id as string);

    // A stale route (e.g. a project deleted while Shipyard was down) and a lost one.
    liveRoutes.clear();
    liveRoutes.set("deleted-project", "gone");

    await deployments.reconcileOnStartup();
    expect(liveRoutes).toEqual(new Map([["docs", live]]));
  });
});

describe("environment variables and secrets", () => {
  async function newProject(cookie: string, repo: string): Promise<string> {
    const created = await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}` });
    expect(created.status).toBe(201);
    return created.body!.data.id as string;
  }

  it("stores every value encrypted and never returns a secret", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await newProject(alice, "env-app");

    expect((await call(alice, "PUT", `/api/projects/${projectId}/env/API_URL`, { value: "https://api.example.com" })).status).toBe(200);
    const saved = await call(alice, "PUT", `/api/projects/${projectId}/env/DATABASE_URL`, {
      value: "postgres://u:hunter2@db/app",
      secret: true,
    });
    expect(saved.body!.data).toMatchObject({ key: "DATABASE_URL", value: null, secret: true, target: "RUNTIME" });

    const listed = await call(alice, "GET", `/api/projects/${projectId}/env`);
    expect(JSON.stringify(listed.body)).not.toContain("hunter2");
    expect(listed.body!.data.map((v: { key: string; value: string | null }) => [v.key, v.value])).toEqual([
      ["API_URL", "https://api.example.com"],
      ["DATABASE_URL", null],
    ]);

    const rows = await prisma.environmentVariable.findMany({ where: { projectId } });
    for (const row of rows) {
      expect(row.value.startsWith("v1:")).toBe(true);
      expect(row.value).not.toContain("hunter2");
      expect(row.value).not.toContain("api.example.com");
    }
  });

  it.each([
    ["PORT", { value: "8080" }, "set by Shipyard"],
    ["1BAD", { value: "x" }, "must start with"],
    ["TOKEN", { value: "x", secret: true, target: "BUILD" }, "only available at runtime"],
    ["NUL", { value: "a\u0000b" }, "NUL"],
  ])("rejects %s %j", async (key, body, message) => {
    const alice = await sessionFor(ALICE);
    const projectId = await newProject(alice, "env-invalid");
    const res = await call(alice, "PUT", `/api/projects/${projectId}/env/${key}`, body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(message);
  });

  it("other users can't read, set or delete a project's variables (404)", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const projectId = await newProject(alice, "env-private");
    await call(alice, "PUT", `/api/projects/${projectId}/env/KEY`, { value: "alice-only" });

    expect((await call(bob, "GET", `/api/projects/${projectId}/env`)).status).toBe(404);
    expect((await call(bob, "PUT", `/api/projects/${projectId}/env/KEY`, { value: "bob" })).status).toBe(404);
    expect((await call(bob, "DELETE", `/api/projects/${projectId}/env/KEY`)).status).toBe(404);
    expect((await call(alice, "GET", `/api/projects/${projectId}/env`)).body!.data[0].value).toBe("alice-only");
  });

  it("hands decrypted values to the deployment: runtime and build, secrets never at build time", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await newProject(alice, "env-deploy");
    const put = (key: string, body: object) => call(alice, "PUT", `/api/projects/${projectId}/env/${key}`, body);
    await put("RUNTIME_ONLY", { value: "r" });
    await put("BUILD_ONLY", { value: "b", target: "BUILD" });
    await put("EVERYWHERE", { value: "e", target: "BOTH" });
    await put("SECRET", { value: "s3cr3t", secret: true });

    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();

    expect(lastJob?.env).toEqual({
      runtime: { RUNTIME_ONLY: "r", EVERYWHERE: "e", SECRET: "s3cr3t" },
      build: { BUILD_ONLY: "b", EVERYWHERE: "e" },
    });
  });

  it("replaces and deletes variables", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await newProject(alice, "env-edit");
    await call(alice, "PUT", `/api/projects/${projectId}/env/MODE`, { value: "one" });
    await call(alice, "PUT", `/api/projects/${projectId}/env/MODE`, { value: "two" });
    expect((await call(alice, "GET", `/api/projects/${projectId}/env`)).body!.data).toMatchObject([{ key: "MODE", value: "two" }]);

    expect((await call(alice, "DELETE", `/api/projects/${projectId}/env/MODE`)).status).toBe(204);
    expect((await call(alice, "DELETE", `/api/projects/${projectId}/env/MODE`)).status).toBe(404);
    expect((await call(alice, "GET", `/api/projects/${projectId}/env`)).body!.data).toEqual([]);
  });

  it("a value copied into another row doesn't decrypt: the deployment fails safely, saying why", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await newProject(alice, "env-tampered");
    await call(alice, "PUT", `/api/projects/${projectId}/env/A`, { value: "a", secret: true });
    await call(alice, "PUT", `/api/projects/${projectId}/env/B`, { value: "b", secret: true });
    // Someone with database access swaps ciphertexts between keys.
    const a = await prisma.environmentVariable.findFirstOrThrow({ where: { projectId, key: "A" } });
    await prisma.environmentVariable.updateMany({ where: { projectId, key: "B" }, data: { value: a.value } });

    const deployed = await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();

    const deployment = await call(alice, "GET", `/api/deployments/${deployed.body!.data.id}`);
    expect(deployment.body!.data).toMatchObject({ status: S.FAILED, failedStage: S.QUEUED });
    expect(deployment.body!.data.errorMessage).toContain("Environment variable B can't be decrypted");
  });
});
