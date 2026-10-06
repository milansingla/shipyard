import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { main as runCli } from "../../../cli/src/main.js";
import { createApp } from "../../src/app.js";
import type { RateLimits } from "../../src/middleware/rateLimit.js";
import type { PrismaClient } from "../../src/db/prisma.js";
import { AppError, ErrorCode, NotFoundError } from "../../src/lib/errors.js";
import { SecretBox } from "../../src/lib/secretBox.js";
import { sessionCookieName } from "../../src/middleware/authenticate.js";
import { AccessService } from "../../src/modules/access/AccessService.js";
import { OrganizationService } from "../../src/modules/access/OrganizationService.js";
import { ConfigSync } from "../../src/modules/services/ConfigSync.js";
import { ServiceService } from "../../src/modules/services/ServiceService.js";
import { VolumeService } from "../../src/modules/services/VolumeService.js";
import { projectNetworkName } from "../../src/modules/services/serviceRules.js";
import { type CronRunner, CronService } from "../../src/modules/cron/CronService.js";
import { ProjectEnvironments } from "../../src/modules/environments/ProjectEnvironments.js";
import { PreviewService } from "../../src/modules/environments/PreviewService.js";
import { WorkerRegistry } from "../../src/modules/workers/WorkerRegistry.js";
import type { OneOffContainerOptions, OneOffResult } from "../../src/services/docker/DockerService.js";
import { AuditService } from "../../src/modules/audit/AuditService.js";
import { ApiKeyService } from "../../src/modules/auth/ApiKeyService.js";
import { AuthService } from "../../src/modules/auth/AuthService.js";
import { BuildLogStore } from "../../src/modules/deployments/BuildLogStore.js";
import { DeploymentService, type EngineLike } from "../../src/modules/deployments/DeploymentService.js";
import { DomainService } from "../../src/modules/domains/DomainService.js";
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
/** Custom hostnames per route, as last activated. */
const liveAliases = new Map<string, readonly string[]>();

/** Behaves like TraefikRouter, minus Traefik: switching is instant. */
const fakeRouter: Router = {
  network: null,
  urlFor: (name) => `http://${name}.localhost`,
  async activate(target) {
    liveRoutes.set(target.name, target.deploymentId);
    liveAliases.set(target.name, target.aliases ?? []);
  },
  async deactivate(name, deploymentId) {
    if (liveRoutes.get(name) === deploymentId) liveRoutes.delete(name);
  },
  async sync(targets) {
    liveRoutes.clear();
    liveAliases.clear();
    for (const target of targets) {
      liveRoutes.set(target.name, target.deploymentId);
      liveAliases.set(target.name, target.aliases ?? []);
    }
  },
};

/** Containers "removed outside Shipyard": the fake engine reports them as gone. */
const removedContainers = new Set<string>();

/** The last job the fake engine was asked to run (to see what it would hand to Docker). */
let lastJob: DeploymentJob | null = null;
/** shipyard.yaml per repository name, as the fake git "reads" it at the branch head. */
const repoFiles = new Map<string, string>();

/** Deployments whose containers and image the fake engine was asked to remove. */
const destroyedDeployments: string[] = [];

/** Docker volumes the fake engine was asked to delete, with their data. */
const removedVolumes: string[] = [];

/** Every job, in the order the fake engine ran them. */
const jobs: DeploymentJob[] = [];

/** run/stop/restart calls in order, to check what happens before what. */
const engineEvents: string[] = [];
/** Service names whose next runs fail (as if never healthy). */
const failRuns = new Set<string>();

/** Walks a deployment to RUNNING instantly, without Docker, routing it like the real engine. */
const fakeEngine: EngineLike = {
  async run(job, observer = {}) {
    lastJob = job;
    jobs.push(job);
    engineEvents.push(`run:${job.service?.alias ?? job.name}`);
    if (failRuns.has(job.service?.alias ?? "")) throw new AppError(ErrorCode.HEALTH_CHECK_FAILED, "Not ready within 120s.");
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
      replicas: job.replicas ?? 1,
      deploymentUrl: null,
      errorMessage: null,
      failedStage: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    for (const status of [S.CLONING, S.DETECTING, S.BUILDING, S.STARTING, S.HEALTH_CHECKING, S.HEALTHY, S.ROUTING, S.RUNNING]) {
      if (status === S.RUNNING) {
        // Like the real engine: only public web services are routed, under their route name.
        if (job.service?.public ?? true) {
          const routeName = job.routeName ?? job.name;
          await fakeRouter.activate({ name: routeName, aliases: job.domains, deploymentId: job.id, containerName: state.containerName, containerPort: 3000 });
          state.deploymentUrl = fakeRouter.urlFor(routeName, 49_999);
        }
      }
      const previous = state.status;
      state.status = status;
      await observer.onStatusChange?.(state, previous);
      if (status === S.CLONING && holdRuns) await holdRuns;
    }
    return state;
  },
  async stop(containerId) {
    engineEvents.push(`stop:${containerId}`);
    return { containerName: "x", status: S.STOPPED, hostPort: null, deploymentUrl: null };
  },
  async restart(containerId, route, onStage = async () => {}) {
    engineEvents.push(`restart:${containerId}`);
    for (const stage of [S.HEALTH_CHECKING, S.HEALTHY, S.ROUTING]) await onStage(stage);
    const deploymentId = containerId.replace(/^container-/, "");
    if (!route) return { containerName: "x", status: S.RUNNING, hostPort: null, deploymentUrl: null };
    await fakeRouter.activate({ name: route.name, aliases: route.aliases, deploymentId, containerName: "x", containerPort: 3000 });
    return { containerName: "x", status: S.RUNNING, hostPort: 49_998, deploymentUrl: fakeRouter.urlFor(route.name, 49_998) };
  },
  async getLogs() {
    return [{ stream: "stdout" as const, text: "hello\n" }];
  },
  async destroy(artifacts) {
    if (artifacts.deploymentId) destroyedDeployments.push(artifacts.deploymentId);
  },
  async inspect(containerId) {
    if (removedContainers.has(containerId)) throw new NotFoundError(`Container not found: ${containerId}`);
    return { running: true, exitCode: null, hostPort: 49_999 };
  },
  async ensureRoutable() {},
  async removeNetwork() {},
  async removeVolumes(names) {
    for (const name of names) removedVolumes.push(name);
  },
  artifactNames: (job) => ({ imageName: `shipyard/${job.name}:x`, containerName: `shipyard-${job.name}-x` }),
  async followLogs(_containerId, _tail, onChunk, signal) {
    onChunk({ stream: "stdout", text: "hello\n" });
    // Like `docker logs --follow`: keeps going until the container stops or the client leaves.
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  },
};

const APP_URL = "http://localhost:3000";
/** The whole suite signs in and deploys far more than a person would; tests tighten one rule when they need to. */
const generous = { limit: 100_000, windowMs: 60_000 };
const rateLimits: RateLimits = { signIn: { ...generous }, webhooks: { ...generous }, deploys: { ...generous }, writes: { ...generous }, reads: { ...generous } };
const WEBHOOK_SECRET = "integration-test-webhook-secret";
const SESSION_COOKIE = sessionCookieName(false);
const ALICE = { id: 1001, login: "alice" };
const BOB = { id: 2002, login: "bob" };
const MALLORY = { id: 3003, login: "mallory" };
const CAROL = { id: 4004, login: "carol" };

let prisma: PrismaClient;
let fakeGitHub: FakeGitHub;
let apiServer: http.Server;
let api: string;
let dataDir: string;
let deployments: DeploymentService;
let environment: EnvironmentService;
let cron: CronService;
let workers: WorkerRegistry;
const WORKER_JOIN_TOKEN = "j".repeat(48);

/** Stands in for Docker when a cron job runs: records what it was asked, answers `cronResult`. */
const cronCalls: OneOffContainerOptions[] = [];
let cronResult: OneOffResult = { exitCode: 0, timedOut: false, oomKilled: false, output: "cleaned 3 rows\n" };
let holdCron: Promise<void> | null = null;
const cronRunner: CronRunner = {
  async runToCompletion(options) {
    cronCalls.push(options);
    if (holdCron) await holdCron;
    return cronResult;
  },
  async removeContainer() {},
};
let audit: AuditService;
let access: AccessService;

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
    allowedUsers: ["alice", "bob", "carol", "alice-renamed"],
    logger: silentLogger,
  });
  const secretBox = new SecretBox(Buffer.alloc(32, 5));
  audit = new AuditService({ prisma, logger: silentLogger });
  access = new AccessService(prisma);
  environment = new EnvironmentService({ prisma, secretBox, access, audit, logger: silentLogger });
  deployments = new DeploymentService({
    prisma,
    access,
    audit,
    configSync: new ConfigSync({
      prisma,
      git: {
        async readFile(repository) {
          const content = repoFiles.get(repository.name);
          return content === undefined ? null : { name: "shipyard.yaml", content, commitSha: "c".repeat(40) };
        },
      },
      allowedGitHosts: ["github.com"],
      environment,
      logger: silentLogger,
    }),
    engine: fakeEngine,
    environment,
    router: fakeRouter,
    buildLogs: new BuildLogStore(dataDir),
    allowedGitHosts: ["github.com"],
    logger: silentLogger,
  });
  const projects = new ProjectService({
    prisma,
    access,
    audit,
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
      audit,
      organizations: new OrganizationService({ prisma, access, audit, logger: silentLogger }),
      services: new ServiceService({ prisma, access, deployments, audit, environment, logger: silentLogger }),
      volumes: new VolumeService({ prisma, access, audit, logger: silentLogger }),
      environments: new ProjectEnvironments({ prisma, access, deployments, logger: silentLogger }),
      workers: (workers = new WorkerRegistry({ prisma, joinToken: WORKER_JOIN_TOKEN, admins: ["alice"], logger: silentLogger })),
      cron: (cron = new CronService({ prisma, access, audit, environment, runner: cronRunner, logger: silentLogger })),
      domains: new DomainService({ prisma, deployments, publicDomain: "localhost", https: false, access, audit, logger: silentLogger }),
      auth: {
        service: auth,
        github,
        sessionCookie: SESSION_COOKIE,
        secureCookies: false,
        appUrl: APP_URL,
        apiKeys: new ApiKeyService({ prisma, audit, logger: silentLogger }),
      },
      webhooks: {
        service: new WebhookService({
          prisma,
          deployments,
          previews: new PreviewService({
            prisma,
            deployments,
            environments: new ProjectEnvironments({ prisma, access, deployments, logger: silentLogger }),
            logger: silentLogger,
          }),
          logger: silentLogger,
        }),
        secret: WEBHOOK_SECRET,
      },
      allowedOrigins: [api, APP_URL],
      logger: silentLogger,
      exposeInternalErrors: true,
      rateLimits,
    }),
  );
});

beforeEach(async () => {
  holdRuns = null;
  await deployments.waitForIdle();
  liveRoutes.clear();
  liveAliases.clear();
  removedContainers.clear();
  jobs.length = 0;
  repoFiles.clear();
  removedVolumes.length = 0;
  destroyedDeployments.length = 0;
  engineEvents.length = 0;
  failRuns.clear();
  cronCalls.length = 0;
  cronResult = { exitCode: 0, timedOut: false, oomKilled: false, output: "cleaned 3 rows\n" };
  holdCron = null;
  await resetTables(prisma);
  await prisma.webhookDelivery.deleteMany();
  await prisma.auditLog.deleteMany();
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
    ["another event type", { action: "opened" }, "issues", "only acts on push and pull_request"],
    ["a malformed pull request", { action: "opened" }, "pull_request", "not a recognisable pull_request payload"],
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

    // …cost exactly one follow-up deployment, triggered by push: Shipyard's doing, not the owner's.
    const pushed = await prisma.deployment.findFirstOrThrow({ where: { projectId, trigger: "PUSH" } });
    expect(await prisma.deploymentEvent.findFirst({ where: { deploymentId: pushed.id, type: "CREATED" } })).toMatchObject({
      actorId: null,
      message: "Push to main",
    });
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

describe("project settings: health checks and resources", () => {
  it("updates health check settings, applied to the next deployment", async () => {
    const alice = await sessionFor(ALICE);
    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/health" });
    const projectId = created.body!.data.id as string;
    expect(created.body!.data).toMatchObject({ healthCheckPath: "/", healthCheckPort: null, healthCheckTimeoutSeconds: null });

    const updated = await call(alice, "PATCH", `/api/projects/${projectId}`, {
      healthCheckPath: "/healthz",
      healthCheckPort: 9000,
      healthCheckTimeoutSeconds: 120,
    });
    expect(updated.status).toBe(200);
    expect(updated.body!.data).toMatchObject({ healthCheckPath: "/healthz", healthCheckPort: 9000, healthCheckTimeoutSeconds: 120 });

    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(lastJob?.healthCheck).toEqual({ path: "/healthz", port: 9000, timeoutMs: 120_000 });

    // null resets to the defaults.
    const reset = await call(alice, "PATCH", `/api/projects/${projectId}`, { healthCheckPort: null, healthCheckTimeoutSeconds: null });
    expect(reset.body!.data).toMatchObject({ healthCheckPath: "/healthz", healthCheckPort: null, healthCheckTimeoutSeconds: null });
  });

  it("sets resource limits, applied to the next deployment", async () => {
    const alice = await sessionFor(ALICE);
    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/limits" });
    const projectId = created.body!.data.id as string;
    expect(created.body!.data).toMatchObject({ cpuLimit: null, memoryLimitMb: null, restartPolicy: "UNLESS_STOPPED" });

    const updated = await call(alice, "PATCH", `/api/projects/${projectId}`, {
      cpuLimit: 0.5,
      memoryLimitMb: 512,
      restartPolicy: "ON_FAILURE",
    });
    expect(updated.body!.data).toMatchObject({ cpuLimit: 0.5, memoryLimitMb: 512, restartPolicy: "ON_FAILURE" });

    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(lastJob?.resources).toEqual({ cpuLimit: 0.5, memoryLimitMb: 512, restartPolicy: "ON_FAILURE" });

    const invalid = await call(alice, "PATCH", `/api/projects/${projectId}`, { memoryLimitMb: 16 });
    expect(invalid.status).toBe(400);
  });

  it("validates settings and keeps them owner-only", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/health2" });
    const projectId = created.body!.data.id as string;

    const invalid = await call(alice, "PATCH", `/api/projects/${projectId}`, { healthCheckPath: "//evil.example/" });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).toContain("single /");
    expect((await call(alice, "PATCH", `/api/projects/${projectId}`, { branch: "dev" })).status).toBe(400);
    expect((await call(bob, "PATCH", `/api/projects/${projectId}`, { healthCheckPath: "/x" })).status).toBe(404);
  });
});

describe("deployment history (events)", () => {
  type Event = { type: string; fromStatus: string | null; toStatus: string | null; actor: string | null; message: string | null };
  const events = async (cookie: string, id: string) =>
    (await call(cookie, "GET", `/api/deployments/${id}/events`)).body!.data as Event[];

  it("records who created a deployment and every status it went through, in order", async () => {
    const alice = await sessionFor(ALICE);
    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/history" });
    const projectId = created.body!.data.id as string;

    const first = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();

    const history = await events(alice, first);
    expect(history[0]).toMatchObject({ type: "CREATED", toStatus: "QUEUED", actor: "alice", message: null });
    expect(history.slice(1).map((e) => `${e.fromStatus}→${e.toStatus}`)).toEqual([
      "QUEUED→CLONING",
      "CLONING→DETECTING",
      "DETECTING→BUILDING",
      "BUILDING→STARTING",
      "STARTING→HEALTH_CHECKING",
      "HEALTH_CHECKING→HEALTHY",
      "HEALTHY→ROUTING",
      "ROUTING→RUNNING",
    ]);
    expect(history.slice(1).every((e) => e.actor === null)).toBe(true); // the pipeline is Shipyard's own work

    // A newer deployment retires it, and the history says why.
    const second = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    expect((await events(alice, first)).slice(-2)).toMatchObject([
      { fromStatus: "RUNNING", toStatus: "STOPPING", actor: null, message: `Replaced by deployment ${second.replace(/-/g, "").slice(0, 7)}` },
      { fromStatus: "STOPPING", toStatus: "STOPPED" },
    ]);

    // A person stopping it is recorded as that person.
    await call(alice, "POST", `/api/deployments/${second}/stop`);
    const stopped = await events(alice, second);
    expect(stopped.at(-2)).toMatchObject({ fromStatus: "RUNNING", toStatus: "STOPPING", actor: "alice" });
    expect(stopped.at(-1)!.toStatus).toBe((await call(alice, "GET", `/api/deployments/${second}`)).body!.data.status);

    // Other users can't read it.
    expect((await call(await sessionFor(BOB), "GET", `/api/deployments/${first}/events`)).status).toBe(404);
  });

  it("records failures with their reason", async () => {
    const alice = await sessionFor(ALICE);
    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/history-fail" });
    const projectId = created.body!.data.id as string;
    await call(alice, "PUT", `/api/projects/${projectId}/env/A`, { value: "a", secret: true });
    await prisma.environmentVariable.updateMany({ where: { projectId }, data: { value: "v1:tampered" } });

    const id = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();

    expect((await events(alice, id)).at(-1)).toMatchObject({
      type: "STATUS_CHANGED",
      fromStatus: "QUEUED",
      toStatus: "FAILED",
      message: expect.stringContaining("can't be decrypted"),
    });
  });
});

describe("rollback", () => {
  async function deployed(cookie: string, projectId: string): Promise<string> {
    const id = (await call(cookie, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    return id;
  }

  it("brings back the previous working deployment, retires the current one, and records it on both", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/roll" })).body!.data.id;
    const a = await deployed(alice, projectId);
    const b = await deployed(alice, projectId);
    expect(liveRoutes.get("roll")).toBe(b);

    const res = await call(alice, "POST", `/api/deployments/${b}/rollback`);
    expect(res.status).toBe(200);
    expect(res.body!.data).toMatchObject({ id: a, status: S.RUNNING });
    expect(liveRoutes.get("roll")).toBe(a);
    expect((await call(alice, "GET", `/api/deployments/${b}`)).body!.data.status).toBe(S.STOPPED);

    const aEvents = (await call(alice, "GET", `/api/deployments/${a}/events`)).body!.data as Array<Record<string, unknown>>;
    const tail = aEvents.slice(-6).map((e) => (e.type === "ROLLBACK" ? "ROLLBACK" : `${e.fromStatus}→${e.toStatus}`));
    expect(tail).toEqual([
      "STOPPED→ROLLING_BACK",
      "ROLLING_BACK→HEALTH_CHECKING",
      "HEALTH_CHECKING→HEALTHY",
      "HEALTHY→ROUTING",
      "ROUTING→RUNNING",
      "ROLLBACK",
    ]);
    expect(aEvents.find((e) => e.toStatus === "ROLLING_BACK")).toMatchObject({ actor: "alice" });
    const bEvents = (await call(alice, "GET", `/api/deployments/${b}/events`)).body!.data as Array<Record<string, unknown>>;
    expect(bEvents.at(-1)).toMatchObject({ type: "ROLLBACK", relatedDeploymentId: a, actor: "alice" });
    expect(bEvents.find((e) => e.toStatus === "STOPPING")).toMatchObject({ message: expect.stringContaining("Rolled back to") });

    // Asking again is harmless: same answer, nothing new happens.
    const eventCount = await prisma.deploymentEvent.count();
    const again = await call(alice, "POST", `/api/deployments/${b}/rollback`);
    expect(again.body!.data).toMatchObject({ id: a, status: S.RUNNING });
    expect(await prisma.deploymentEvent.count()).toBe(eventCount);
  });

  it("skips deployments whose container is gone, and says so when nothing is left", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/roll2" })).body!.data.id;
    const a = await deployed(alice, projectId);
    const b = await deployed(alice, projectId);
    const c = await deployed(alice, projectId);
    removedContainers.add(`container-${b}`);

    expect((await call(alice, "POST", `/api/deployments/${c}/rollback`)).body!.data.id).toBe(a);

    removedContainers.add(`container-${a}`);
    const d = await deployed(alice, projectId);
    const none = await call(alice, "POST", `/api/deployments/${a}/rollback`);
    expect(none.status).toBe(409);
    expect(none.body!.error).toMatchObject({ code: "NO_ROLLBACK_TARGET" });
    expect(liveRoutes.get("roll2")).toBe(d); // nothing changed
  });

  it("is owner-only", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/roll3" })).body!.data.id;
    await deployed(alice, projectId);
    const b = await deployed(alice, projectId);
    expect((await call(await sessionFor(BOB), "POST", `/api/deployments/${b}/rollback`)).status).toBe(404);
  });
});


describe("live logs (Server-Sent Events)", () => {
  /** Reads SSE frames until `stopAfter` returns true or the stream ends. */
  async function readEvents(
    cookie: string,
    route: string,
    stopAfter: (events: Array<{ event: string; data: Record<string, unknown> }>) => boolean = () => false,
  ) {
    const abort = new AbortController();
    const res = await fetch(`${api}${route}`, { headers: { cookie }, signal: abort.signal });
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    if (!res.ok || !res.body) return { status: res.status, contentType: res.headers.get("content-type"), events };
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
        if (stopAfter(events)) break;
      }
    } finally {
      abort.abort();
    }
    return { status: res.status, contentType: res.headers.get("content-type"), events };
  }

  async function finishedDeployment(cookie: string, repo: string): Promise<string> {
    const projectId = (await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}` })).body!.data.id;
    const id = (await call(cookie, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    return id;
  }

  it("streams a finished build log in full, then ends", async () => {
    const alice = await sessionFor(ALICE);
    const id = await finishedDeployment(alice, "sse-build");
    const stored = (await call(alice, "GET", `/api/deployments/${id}/logs?type=build`)).body!.data.content as string;

    const { status, contentType, events } = await readEvents(alice, `/api/deployments/${id}/logs/stream?type=build`);
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
    expect(events.at(-1)).toEqual({ event: "end", data: {} });
    expect(events.filter((e) => e.event === "log").map((e) => e.data.text).join("")).toBe(stored);
  });

  it("streams the app's output while it runs", async () => {
    const alice = await sessionFor(ALICE);
    const id = await finishedDeployment(alice, "sse-runtime");
    const { events } = await readEvents(alice, `/api/deployments/${id}/logs/stream?type=runtime`, (e) => e.length > 0);
    expect(events[0]).toEqual({ event: "log", data: { text: "hello\n" } });
  });

  it("is owner-only, and caps open streams per user", async () => {
    const alice = await sessionFor(ALICE);
    const id = await finishedDeployment(alice, "sse-limits");
    expect((await readEvents(await sessionFor(BOB), `/api/deployments/${id}/logs/stream`)).status).toBe(404);

    // Ten runtime streams stay open (the fake container keeps running)…
    const open = Array.from({ length: 10 }, () => new AbortController());
    const responses = await Promise.all(
      open.map((abort) => fetch(`${api}/api/deployments/${id}/logs/stream?type=runtime`, { headers: { cookie: alice }, signal: abort.signal })),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    // …the eleventh is refused.
    expect((await call(alice, "GET", `/api/deployments/${id}/logs/stream?type=runtime`)).status).toBe(429);

    for (const abort of open) abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await readEvents(alice, `/api/deployments/${id}/logs/stream?type=runtime`, (e) => e.length > 0)).status).toBe(200);
  });
});

describe("custom domains", () => {
  async function liveProject(cookie: string, repo: string) {
    const projectId = (await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}` })).body!.data.id as string;
    await call(cookie, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    return projectId;
  }

  it("routes a custom domain to the live deployment right away, and to every later one", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await liveProject(alice, "shop");

    const added = await call(alice, "POST", `/api/projects/${projectId}/domains`, { hostname: " Shop.Example.COM. " });
    expect(added.status).toBe(201);
    expect(added.body!.data).toMatchObject({ hostname: "shop.example.com", url: "http://shop.example.com" });
    expect(liveAliases.get("shop")).toEqual(["shop.example.com"]);

    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(lastJob?.domains).toEqual(["shop.example.com"]);

    expect((await call(alice, "DELETE", `/api/projects/${projectId}/domains/shop.example.com`)).status).toBe(204);
    expect(liveAliases.get("shop")).toEqual([]);
    expect((await call(alice, "GET", `/api/projects/${projectId}/domains`)).body!.data).toEqual([]);
  });

  it.each([
    ["localhost", "not a hostname"],
    ["https://shop.example.com", "not a hostname"],
    ["*.example.com", "not a hostname"],
    ["other.localhost", "Shipyard's own"],
  ])("rejects %s", async (hostname, message) => {
    const alice = await sessionFor(ALICE);
    const projectId = await liveProject(alice, "shop-invalid");
    const res = await call(alice, "POST", `/api/projects/${projectId}/domains`, { hostname });
    expect(res.status).toBe(400);
    expect(res.body!.error.message).toContain(message);
  });

  it("gives each hostname to one project, without saying whose; owner-only", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const aliceProject = await liveProject(alice, "taken-a");
    const bobProject = (await call(bob, "POST", "/api/projects", { repositoryUrl: "https://github.com/bob/taken-b" })).body!.data.id;

    await call(alice, "POST", `/api/projects/${aliceProject}/domains`, { hostname: "taken.example.com" });
    const conflict = await call(bob, "POST", `/api/projects/${bobProject}/domains`, { hostname: "taken.example.com" });
    expect(conflict.status).toBe(409);
    expect(conflict.body!.error).toEqual({ code: "DOMAIN_TAKEN", message: "taken.example.com is already used by a project." });

    expect((await call(bob, "GET", `/api/projects/${aliceProject}/domains`)).status).toBe(404);
    expect((await call(bob, "DELETE", `/api/projects/${aliceProject}/domains/taken.example.com`)).status).toBe(404);
  });

  it("rebuilds custom domains into the route table at startup", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await liveProject(alice, "boot");
    await call(alice, "POST", `/api/projects/${projectId}/domains`, { hostname: "boot.example.com" });
    liveAliases.clear();
    await deployments.reconcileOnStartup();
    expect(liveAliases.get("boot")).toEqual(["boot.example.com"]);
  });
});

describe("rate limiting per user", () => {
  it("limits deploys per user, separately from other users and from reads", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const project = async (cookie: string, repo: string) =>
      (await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}` })).body!.data.id as string;
    const aliceProject = await project(alice, "limited-a");
    const bobProject = await project(bob, "limited-b");

    rateLimits.deploys.limit = 2;
    try {
      for (let i = 0; i < 2; i += 1) {
        expect((await call(alice, "POST", `/api/projects/${aliceProject}/deploy`)).status).toBe(202);
        await deployments.waitForIdle();
      }
      const refused = await call(alice, "POST", `/api/projects/${aliceProject}/deploy`);
      expect(refused.status).toBe(429);
      expect(refused.body!.error.code).toBe("RATE_LIMITED");

      expect((await call(bob, "POST", `/api/projects/${bobProject}/deploy`)).status).toBe(202); // Bob has his own budget
      expect((await call(alice, "GET", `/api/projects/${aliceProject}`)).status).toBe(200); // reading still works
      await deployments.waitForIdle();
    } finally {
      rateLimits.deploys.limit = generous.limit;
    }
  });
});

describe("API keys", () => {
  const bearer = async (token: string, method: string, route: string, body?: unknown) => {
    const res = await fetch(`${api}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };

  it("shows the token once, stores only its hash, and authenticates as its owner", async () => {
    const alice = await sessionFor(ALICE);
    const created = await call(alice, "POST", "/api/api-keys", { name: "laptop CLI" });
    expect(created.status).toBe(201);
    const token = created.body!.data.token as string;
    expect(token).toMatch(/^shp_[A-Za-z0-9_-]{43}$/);
    expect(created.body!.data.key).toMatchObject({ name: "laptop CLI", prefix: token.slice(0, 12), revokedAt: null });

    const stored = await prisma.apiKey.findFirstOrThrow({ where: { name: "laptop CLI" } });
    expect(JSON.stringify(stored)).not.toContain(token);
    const listed = await call(alice, "GET", "/api/api-keys");
    expect(JSON.stringify(listed.body)).not.toContain(token.slice(12));

    expect((await bearer(token, "GET", "/api/auth/me")).body!.data.login).toBe("alice");
    expect((await bearer(token, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/keyed" })).status).toBe(201);
    expect((await prisma.apiKey.findFirstOrThrow({ where: { id: stored.id } })).lastUsedAt).not.toBeNull();
  });

  it("stops working when revoked or expired; a wrong key is just 'signed out'", async () => {
    const alice = await sessionFor(ALICE);
    const { token, key } = (await call(alice, "POST", "/api/api-keys", { name: "ci" })).body!.data;
    expect((await call(alice, "DELETE", `/api/api-keys/${key.id}`)).status).toBe(204);
    expect((await bearer(token, "GET", "/api/projects")).status).toBe(401);
    expect((await call(alice, "DELETE", `/api/api-keys/${key.id}`)).status).toBe(204); // idempotent

    const expiring = (await call(alice, "POST", "/api/api-keys", { name: "short", expiresInDays: 1 })).body!.data;
    await prisma.apiKey.update({ where: { id: expiring.key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await bearer(expiring.token, "GET", "/api/projects")).status).toBe(401);

    expect((await bearer("shp_" + "x".repeat(43), "GET", "/api/projects")).status).toBe(401);
  });

  it("can't create more keys, and can't touch another user's keys", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const { token, key } = (await call(alice, "POST", "/api/api-keys", { name: "mine" })).body!.data;

    const minted = await bearer(token, "POST", "/api/api-keys", { name: "escalate" });
    expect(minted.status).toBe(403);
    expect((await call(bob, "DELETE", `/api/api-keys/${key.id}`)).status).toBe(404);
    expect((await call(bob, "GET", "/api/api-keys")).body!.data).toEqual([]);
  });

  it("is refused for users removed from the allowlist", async () => {
    // A key whose owner is no longer on the allowlist (here: a login that never was).
    const user = await prisma.user.create({ data: { githubId: 9_999n, login: "removed", githubAccessToken: "v1:x" } });
    const service = new ApiKeyService({ prisma, audit, logger: silentLogger });
    const { token } = await service.create(user.id, { name: "old" });
    expect((await bearer(token, "GET", "/api/projects")).status).toBe(401);
  });
});

describe("audit log", () => {
  it("records who did what, without secret values, and keeps it after the project is deleted", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/audited" })).body!.data.id;
    await call(alice, "PUT", `/api/projects/${projectId}/env/DB_PASSWORD`, { value: "hunter2", secret: true });
    await call(alice, "POST", `/api/projects/${projectId}/domains`, { hostname: "audited.example.com" });
    await call(alice, "PATCH", `/api/projects/${projectId}`, { memoryLimitMb: 256 });
    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    await call(alice, "DELETE", `/api/projects/${projectId}/env/DB_PASSWORD`);
    await call(alice, "POST", "/api/api-keys", { name: "audit-test" });

    const log = (await call(alice, "GET", "/api/audit-logs")).body!.data as Array<Record<string, any>>;
    expect(log.map((e) => e.action).reverse()).toEqual([
      "PROJECT_CREATED",
      "ENV_VAR_SET",
      "DOMAIN_ADDED",
      "PROJECT_SETTINGS_CHANGED",
      "DEPLOYMENT_STARTED",
      "DEPLOYMENT_SUCCEEDED",
      "ENV_VAR_DELETED",
      "API_KEY_CREATED",
    ]);
    expect(JSON.stringify(log)).not.toContain("hunter2");
    expect(log.find((e) => e.action === "ENV_VAR_SET")).toMatchObject({ actor: "alice", metadata: { key: "DB_PASSWORD", secret: true } });
    expect(log.find((e) => e.action === "DEPLOYMENT_SUCCEEDED")).toMatchObject({ actor: null, projectName: "audited" });

    // Bob sees none of it.
    expect((await call(bob, "GET", "/api/audit-logs")).body!.data).toEqual([]);

    // Deleting the project is recorded, and the trail survives it.
    await call(alice, "DELETE", `/api/projects/${projectId}`);
    const after = (await call(alice, "GET", "/api/audit-logs")).body!.data as Array<Record<string, any>>;
    expect(after[0]).toMatchObject({ action: "PROJECT_DELETED", actor: "alice", projectName: "audited" });
    expect(after).toHaveLength(9);
  });
});

describe("teams and roles", () => {
  async function team(owner: string, name: string): Promise<string> {
    const res = await call(owner, "POST", "/api/organizations", { name });
    expect(res.status).toBe(201);
    return res.body!.data.id as string;
  }

  it("gives each role exactly its powers on a team's projects", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const carol = await sessionFor(CAROL);
    const orgId = await team(alice, "Acme Team");
    expect((await call(alice, "POST", `/api/organizations/${orgId}/members`, { login: "BOB", role: "VIEWER" })).status).toBe(201);
    const bobId = (await prisma.user.findFirstOrThrow({ where: { login: "bob" } })).id;

    const created = await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/shared", organizationId: orgId });
    expect(created.status).toBe(201);
    const projectId = created.body!.data.id as string;
    await call(alice, "PUT", `/api/projects/${projectId}/env/API_URL`, { value: "https://api" });
    const deployed = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();

    // VIEWER: reads everything except variable values; changes nothing.
    const listed = (await call(bob, "GET", "/api/projects")).body!.data as Array<Record<string, any>>;
    expect(listed.map((p) => [p.id, p.role, p.organization.name])).toEqual([[projectId, "VIEWER", "Acme Team"]]);
    expect((await call(bob, "GET", `/api/deployments/${deployed}/events`)).status).toBe(200);
    expect((await call(bob, "GET", `/api/projects/${projectId}/env`)).body!.data).toMatchObject([{ key: "API_URL", value: null }]);
    const denied = await call(bob, "POST", `/api/projects/${projectId}/deploy`);
    expect(denied.status).toBe(403);
    expect(denied.body!.error.message).toBe("This needs the DEVELOPER role or higher in Acme Team; you are VIEWER.");
    expect((await call(bob, "PUT", `/api/projects/${projectId}/env/X`, { value: "1" })).status).toBe(403);
    expect((await call(bob, "POST", `/api/deployments/${deployed}/stop`)).status).toBe(403);

    // DEVELOPER: deploys and changes variables, but not settings, domains or deletion.
    expect((await call(alice, "PATCH", `/api/organizations/${orgId}/members/${bobId}`, { role: "DEVELOPER" })).status).toBe(204);
    expect((await call(bob, "GET", `/api/projects/${projectId}/env`)).body!.data[0].value).toBe("https://api");
    expect((await call(bob, "POST", `/api/projects/${projectId}/deploy`)).status).toBe(202);
    await deployments.waitForIdle();
    expect((await call(bob, "PATCH", `/api/projects/${projectId}`, { memoryLimitMb: 256 })).status).toBe(403);
    expect((await call(bob, "POST", `/api/projects/${projectId}/domains`, { hostname: "shared.example.com" })).status).toBe(403);
    expect((await call(bob, "DELETE", `/api/projects/${projectId}`)).status).toBe(403);

    // Outsiders can't even tell the project exists.
    expect((await call(carol, "GET", `/api/projects/${projectId}`)).status).toBe(404);
    expect((await call(carol, "GET", `/api/deployments/${deployed}`)).status).toBe(404);
    expect((await call(carol, "GET", `/api/organizations/${orgId}/members`)).status).toBe(404);

    // Team members see the team's activity.
    const activity = (await call(bob, "GET", "/api/audit-logs")).body!.data as Array<Record<string, any>>;
    expect(activity.map((e) => e.action)).toEqual(expect.arrayContaining(["PROJECT_CREATED", "MEMBER_ADDED", "MEMBER_ROLE_CHANGED"]));
  });

  it("keeps OWNER/ADMIN changes for owners, and always one owner", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    await sessionFor(CAROL);
    const orgId = await team(alice, "Roles Team");
    const [aliceId, bobId, carolId] = await Promise.all(
      ["alice", "bob", "carol"].map(async (login) => (await prisma.user.findFirstOrThrow({ where: { login } })).id),
    );
    await call(alice, "POST", `/api/organizations/${orgId}/members`, { login: "bob", role: "ADMIN" });

    // An ADMIN manages developers and viewers only.
    expect((await call(bob, "POST", `/api/organizations/${orgId}/members`, { login: "carol", role: "ADMIN" })).status).toBe(403);
    expect((await call(bob, "POST", `/api/organizations/${orgId}/members`, { login: "carol", role: "DEVELOPER" })).status).toBe(201);
    expect((await call(bob, "PATCH", `/api/organizations/${orgId}/members/${carolId}`, { role: "VIEWER" })).status).toBe(204);
    expect((await call(bob, "DELETE", `/api/organizations/${orgId}/members/${aliceId}`)).status).toBe(403);
    expect((await call(bob, "POST", `/api/organizations/${orgId}/members`, { login: "carol" })).status).toBe(409);

    // The last OWNER can't step down or leave.
    const lastOwner = await call(alice, "PATCH", `/api/organizations/${orgId}/members/${aliceId}`, { role: "ADMIN" });
    expect(lastOwner.status).toBe(409);
    expect(lastOwner.body!.error.code).toBe("LAST_OWNER");
    expect((await call(alice, "DELETE", `/api/organizations/${orgId}/members/${aliceId}`)).status).toBe(409);

    // Anyone may leave; personal organizations stay single-member.
    expect((await call(bob, "DELETE", `/api/organizations/${orgId}/members/${bobId}`)).status).toBe(204);
    const personal = ((await call(alice, "GET", "/api/organizations")).body!.data as Array<Record<string, any>>).find((o) => o.personal);
    expect(personal).toMatchObject({ slug: "user-alice", role: "OWNER", members: 1 });
    expect((await call(alice, "POST", `/api/organizations/${personal!.id}/members`, { login: "bob" })).status).toBe(400);
    expect((await call(alice, "POST", `/api/organizations/${orgId}/members`, { login: "nobody-here" })).status).toBe(404);
  });

  it("a push deploys a team project as Shipyard, whoever created it", async () => {
    const alice = await sessionFor(ALICE);
    const orgId = await team(alice, "Push Team");
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/team-push", organizationId: orgId })).body!.data.id;
    const result = await deployments.deployOnPush(projectId);
    expect(result.outcome).toBe("started");
    await deployments.waitForIdle();
    expect((await prisma.deploymentEvent.findFirstOrThrow({ where: { type: "CREATED", deployment: { projectId } } })).actorId).toBeNull();
  });
});


describe("shipyard CLI against the API", () => {
  async function cli(args: string[], configPath: string, env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, {
      env,
      stdout: (t) => void out.push(t),
      stderr: (t) => void err.push(t),
      readLine: async () => "",
      configPath,
    });
    return { code, out: out.join(""), err: err.join("") };
  }

  it("logs in with an API key and does a day's work: projects, env, deploy, status, logs, rollback", async () => {
    const alice = await sessionFor(ALICE);
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-cli-it-"));
    const config = path.join(configDir, "cli.json");
    try {
      const { token } = (await call(alice, "POST", "/api/api-keys", { name: "cli" })).body!.data;
      await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/cli-app" });

      const login = await cli(["login", "--url", api, "--token", token], config);
      expect(login).toMatchObject({ code: 0, out: `Signed in to ${api} as alice.\n` });

      expect((await cli(["projects"], config)).out).toMatch(/^NAME\s+TEAM\s+STATUS\s+URL\ncli-app\s+—\s+never deployed\n$/);

      expect((await cli(["env", "cli-app", "set", "API_TOKEN=s3cret=yes", "--secret"], config)).out).toContain("Set API_TOKEN (secret)");
      const listed = await cli(["env", "cli-app"], config);
      expect(listed.out).toContain("API_TOKEN  (secret)  runtime");
      expect(listed.out).not.toContain("s3cret");

      const first = await cli(["deploy", "cli-app"], config);
      expect(first.code).toBe(0);
      expect(first.out).toContain("Live at http://cli-app.localhost");
      await deployments.waitForIdle();
      expect(lastJob?.env?.runtime).toEqual({ API_TOKEN: "s3cret=yes" }); // `=` inside the value survives

      expect((await cli(["deploy", "cli-app", "--no-follow"], config)).code).toBe(0);
      await deployments.waitForIdle();
      expect((await cli(["status", "cli-app"], config)).out).toMatch(/Live at http:\/\/cli-app\.localhost — deployment/);
      expect((await cli(["logs", "cli-app"], config)).out).toBe("hello\n");

      const rolledBack = await cli(["rollback", "cli-app"], config);
      expect(rolledBack.code).toBe(0);
      expect(rolledBack.out).toMatch(/is live again at http:\/\/cli-app\.localhost/);

      // Errors come back as the API's own words, with a non-zero exit.
      const missing = await cli(["status", "nope"], config);
      expect(missing).toMatchObject({ code: 1, err: 'No project "nope". `shipyard projects` lists yours.\n' });

      // A revoked key stops the CLI too.
      const keyId = (await prisma.apiKey.findFirstOrThrow({ where: { name: "cli" } })).id;
      await call(alice, "DELETE", `/api/api-keys/${keyId}`);
      expect((await cli(["projects"], config)).err).toContain("Run `shipyard login`");
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

describe("multi-service projects", () => {
  async function project(cookie: string, repo: string): Promise<string> {
    const res = await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}` });
    expect(res.status).toBe(201);
    return res.body!.data.id as string;
  }
  const addService = (cookie: string, projectId: string, body: object) => call(cookie, "POST", `/api/projects/${projectId}/services`, body);

  it("deploys every service, internal ones first, routing only public web services", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await project(alice, "stack");
    const services = (await call(alice, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>;
    expect(services).toMatchObject([{ name: "web", type: "WEB", public: true, primary: true, routeName: "stack" }]);

    expect((await addService(alice, projectId, { name: "api", sourceDir: "api", port: 4000, public: false, startCommand: "node server.js" })).status).toBe(201);
    expect((await addService(alice, projectId, { name: "jobs", type: "WORKER", sourceDir: "worker" })).status).toBe(201);
    expect((await addService(alice, projectId, { name: "admin", sourceDir: "admin" })).status).toBe(201);

    const deployed = await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    expect(deployed.status).toBe(202);
    await deployments.waitForIdle();
    const web = services[0]!;
    expect(deployed.body!.data.serviceId).toBe(web.id); // the primary's deployment comes back

    // Internal services first, the primary last.
    expect(jobs.map((job) => job.service?.alias)).toEqual(["api", "jobs", "admin", "web"]);
    const network = jobs[0]!.service!.network;
    expect(jobs.every((job) => job.service!.network === network)).toBe(true);
    expect(jobs[0]).toMatchObject({ service: { sourceDir: "api", port: 4000, public: false, startCommand: "node server.js" } });
    expect(jobs[1]!.service).toMatchObject({ type: "WORKER", public: false });

    // Only public web services get an address.
    expect(new Map(liveRoutes)).toEqual(
      new Map([
        ["admin-stack", jobs[2]!.id],
        ["stack", jobs[3]!.id],
      ]),
    );
    const listed = (await call(alice, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>;
    const admin = listed.find((service) => service.name === "admin")!;
    await call(alice, "POST", `/api/projects/${projectId}/domains`, { hostname: "admin.example.com", serviceId: admin.id });
    expect(liveAliases.get("admin-stack")).toEqual(["admin.example.com"]);
    expect(liveAliases.get("stack")).toEqual([]);
    expect(listed.map((s) => [s.name, s.routeName, s.latestDeployment.status])).toEqual([
      ["web", "stack", "RUNNING"],
      ["api", null, "RUNNING"],
      ["jobs", null, "RUNNING"],
      ["admin", "admin-stack", "RUNNING"],
    ]);
  });

  it("gives each service the project's variables, overridden by its own", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await project(alice, "scoped");
    const api = (await addService(alice, projectId, { name: "api", public: false })).body!.data;
    await call(alice, "PUT", `/api/projects/${projectId}/env/LOG_LEVEL`, { value: "info" });
    await call(alice, "PUT", `/api/projects/${projectId}/env/LOG_LEVEL?service=${api.id}`, { value: "debug" });
    await call(alice, "PUT", `/api/projects/${projectId}/env/DB_URL?service=${api.id}`, { value: "postgres://x", secret: true });

    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    const envOf = (alias: string) => jobs.find((job) => job.service?.alias === alias)!.env!.runtime;
    expect(envOf("api")).toEqual({ LOG_LEVEL: "debug", DB_URL: "postgres://x" });
    expect(envOf("web")).toEqual({ LOG_LEVEL: "info" });

    const listed = (await call(alice, "GET", `/api/projects/${projectId}/env`)).body!.data as Array<Record<string, any>>;
    expect(listed.map((v) => [v.key, v.serviceId])).toEqual([
      ["DB_URL", api.id],
      ["LOG_LEVEL", api.id],
      ["LOG_LEVEL", null],
    ]);
    expect((await call(alice, "DELETE", `/api/projects/${projectId}/env/LOG_LEVEL?service=${api.id}`)).status).toBe(204);
    expect((await call(alice, "GET", `/api/projects/${projectId}/env`)).body!.data).toHaveLength(2);
  });

  it("validates services and who may change them", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const projectId = await project(alice, "rules");

    for (const body of [
      { name: "Bad_Name" },
      { name: "a--b" },
      { name: "w", type: "WORKER", public: true },
      { name: "up", sourceDir: "../outside" },
      { name: "cmd", startCommand: "node a.js\nrm -rf /" },
    ]) {
      expect({ body, status: (await addService(alice, projectId, body)).status }).toEqual({ body, status: 400 });
    }
    expect((await addService(alice, projectId, { name: "web" })).status).toBe(409);
    expect((await addService(bob, projectId, { name: "api" })).status).toBe(404);

    const only = ((await call(alice, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>)[0]!;
    expect((await call(alice, "DELETE", `/api/services/${only.id}`)).status).toBe(409); // a project keeps one service
  });

  it("never lets two things share an address", async () => {
    const alice = await sessionFor(ALICE);
    const shop = await project(alice, "shop");
    await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/admin-shop" });
    // A service "admin" in "shop" would be served at admin-shop: taken by a project.
    expect((await addService(alice, shop, { name: "admin" })).status).toBe(409);
    expect((await addService(alice, shop, { name: "api" })).status).toBe(201);
    // …and the other way round: a project can't take a service's address.
    expect((await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/api-shop" })).status).toBe(409);
  });

  it("deploys, rolls back and deletes one service without touching the others", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await project(alice, "solo");
    const api = (await addService(alice, projectId, { name: "api", public: false })).body!.data;
    await call(alice, "PUT", `/api/projects/${projectId}/env/ONLY_API?service=${api.id}`, { value: "1" });

    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    jobs.length = 0;
    const second = await call(alice, "POST", `/api/services/${api.id}/deploy`);
    expect(second.status).toBe(202);
    await deployments.waitForIdle();
    expect(jobs.map((job) => job.service?.alias)).toEqual(["api"]);

    // A domain can point at a specific public web service, not a private one.
    expect((await call(alice, "POST", `/api/projects/${projectId}/domains`, { hostname: "api.example.com", serviceId: api.id })).status).toBe(400);

    const webRunning = await prisma.deployment.findFirstOrThrow({ where: { projectId, status: "RUNNING", service: { name: "web" } } });
    const rolledBack = await call(alice, "POST", `/api/deployments/${second.body!.data.id}/rollback`);
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body!.data.serviceId).toBe(api.id);
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: webRunning.id } })).status).toBe("RUNNING"); // untouched

    expect((await call(alice, "DELETE", `/api/services/${api.id}`)).status).toBe(204);
    expect(await prisma.deployment.count({ where: { serviceId: api.id } })).toBe(0);
    expect(await prisma.environmentVariable.count({ where: { projectId, scope: api.id } })).toBe(0);
    expect(await prisma.deployment.count({ where: { projectId } })).toBe(1); // web's deployment remains
  });
});

describe("shipyard.yaml", () => {
  const buildLog = async (cookie: string, id: string) =>
    (await call(cookie, "GET", `/api/deployments/${id}/logs?type=build`)).body!.data.content as string;

  it("creates and updates services from the file at each deploy; dashboard changes win; nothing is deleted", async () => {
    const alice = await sessionFor(ALICE);
    repoFiles.set("yaml-app", `
version: 1
services:
  web:
    source: apps/web
  api:
    source: apps/api
    port: 4000
    public: false
    start:
      command: node server.js
  jobs:
    type: worker
    source: apps/worker
`);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/yaml-app" })).body!.data.id;
    const first = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();

    const services = (await call(alice, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>;
    expect(services.map((s) => [s.name, s.type, s.sourceDir, s.port, s.public, s.managedBy])).toEqual([
      ["web", "WEB", "apps/web", null, true, "CONFIG_FILE"],
      ["api", "WEB", "apps/api", 4000, false, "CONFIG_FILE"],
      ["jobs", "WORKER", "apps/worker", null, false, "CONFIG_FILE"],
    ]);
    expect(jobs.map((job) => job.service?.alias)).toEqual(["api", "jobs", "web"]);
    expect(await buildLog(alice, first)).toContain("shipyard.yaml: added service api");

    // A dashboard change outranks the file…
    const api = services.find((s) => s.name === "api")!;
    expect((await call(alice, "PATCH", `/api/services/${api.id}`, { port: 5000 })).status).toBe(200);
    // …the file changes something else and drops the worker.
    repoFiles.set("yaml-app", `
version: 1
services:
  web:
    source: apps/web
  api:
    source: apps/api
    port: 4000
    public: false
    start:
      command: node index.js
`);
    jobs.length = 0;
    const second = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();

    const after = await prisma.service.findFirstOrThrow({ where: { id: api.id } });
    expect(after).toMatchObject({ port: 5000, startCommand: "node index.js", overrides: ["port"] });
    const log = await buildLog(alice, second);
    expect(log).toContain("shipyard.yaml: updated api: startCommand");
    expect(log).toContain("shipyard.yaml: kept the dashboard's port for api");
    expect(log).toContain("service jobs is no longer in shipyard.yaml");
    expect(await prisma.service.count({ where: { projectId } })).toBe(3); // the worker is still there
  });

  it("an invalid file fails the deploy visibly instead of silently", async () => {
    const alice = await sessionFor(ALICE);
    repoFiles.set("bad-yaml", "version: 1\nservices:\n  web:\n    sorce: .\n");
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/bad-yaml" })).body!.data.id;

    const res = await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    expect(res.status).toBe(202);
    expect(res.body!.data).toMatchObject({ status: "FAILED", failedStage: "QUEUED" });
    expect(res.body!.data.errorMessage).toContain("shipyard.yaml is invalid at services.web");
    expect(await buildLog(alice, res.body!.data.id)).toContain("ERROR: shipyard.yaml is invalid");
    expect(jobs).toHaveLength(0); // nothing was built
    // The project isn't stuck: fix the file, deploy again.
    repoFiles.set("bad-yaml", "version: 1\nservices:\n  web: {}\n");
    expect((await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.status).toBe("QUEUED");
    await deployments.waitForIdle();
  });
});


describe("persistent volumes", () => {
  async function serviceOf(cookie: string, repo: string, organizationId?: string) {
    const created = await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}`, organizationId });
    expect(created.status).toBe(201);
    const projectId = created.body!.data.id as string;
    const [web] = (await call(cookie, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>;
    return { projectId, serviceId: web!.id as string };
  }
  const addVolume = (cookie: string, serviceId: string, body: object) => call(cookie, "POST", `/api/services/${serviceId}/volumes`, body);

  it("mounts a service's volumes into every later deployment, under a name no other service can reuse", async () => {
    const alice = await sessionFor(ALICE);
    const { projectId, serviceId } = await serviceOf(alice, "uploads");
    const created = await addVolume(alice, serviceId, { name: "uploads", mountPath: "/app/uploads" });
    expect(created.status).toBe(201);
    expect(created.body!.data).toMatchObject({ name: "uploads", mountPath: "/app/uploads", dockerName: `shipyard-${serviceId}-uploads` });

    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(lastJob?.volumes).toEqual([{ name: `shipyard-${serviceId}-uploads`, mountPath: "/app/uploads" }]);

    const listed = await call(alice, "GET", `/api/services/${serviceId}/volumes`);
    expect(listed.body!.data.map((v: Record<string, unknown>) => v.name)).toEqual(["uploads"]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "VOLUME_CREATED" } });
    expect(audit.metadata).toMatchObject({ service: "web", volume: "uploads", mountPath: "/app/uploads" });
  });

  it("validates names and paths; one name and one path per service", async () => {
    const alice = await sessionFor(ALICE);
    const { serviceId } = await serviceOf(alice, "paths");
    for (const body of [
      { name: "Data", mountPath: "/data" },
      { name: "data", mountPath: "data" },
      { name: "data", mountPath: "/" },
      { name: "data", mountPath: "/etc" },
      { name: "data", mountPath: "/app/../etc" },
      { name: "data", mountPath: "/data", extra: true },
    ]) {
      expect({ body, status: (await addVolume(alice, serviceId, body)).status }).toEqual({ body, status: 400 });
    }
    expect((await addVolume(alice, serviceId, { name: "data", mountPath: "/data" })).status).toBe(201);
    expect((await addVolume(alice, serviceId, { name: "data", mountPath: "/other" })).status).toBe(409);
    expect((await addVolume(alice, serviceId, { name: "other", mountPath: "/data" })).status).toBe(409);
  });

  it("removing a volume only detaches it; deleting its data must be asked for explicitly", async () => {
    const alice = await sessionFor(ALICE);
    const { projectId, serviceId } = await serviceOf(alice, "keep-data");
    const api = (await call(alice, "POST", `/api/projects/${projectId}/services`, { name: "api", public: false })).body!.data;
    const cache = (await addVolume(alice, serviceId, { name: "cache", mountPath: "/cache" })).body!.data;
    await addVolume(alice, api.id, { name: "db", mountPath: "/var/lib/data" });

    const detached = await call(alice, "DELETE", `/api/volumes/${cache.id}`);
    expect(detached.status).toBe(200);
    expect(detached.body!.data).toEqual({ dockerName: `shipyard-${serviceId}-cache` });
    expect(removedVolumes).toEqual([]); // the data stays on the server
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "VOLUME_DELETED" } })).toMatchObject({
      metadata: { service: "web", volume: "cache", dataKept: true },
    });

    // A service or project with volumes isn't deleted by accident.
    const refused = await call(alice, "DELETE", `/api/services/${api.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body!.error).toMatchObject({ code: "VOLUMES_EXIST" });
    expect(refused.body!.error.message).toContain("deleteData=true");
    expect((await call(alice, "DELETE", `/api/projects/${projectId}`)).status).toBe(409);
    expect((await call(alice, "DELETE", `/api/services/${api.id}?deleteData=maybe`)).status).toBe(400);
    expect(await prisma.service.count({ where: { projectId } })).toBe(2);

    expect((await call(alice, "DELETE", `/api/services/${api.id}?deleteData=true`)).status).toBe(204);
    expect(removedVolumes).toEqual([`shipyard-${api.id}-db`]);
    expect(await prisma.volume.count({ where: { serviceId: api.id } })).toBe(0);
  });

  it("deleting a project with deleteData=true removes its volumes after its containers", async () => {
    const alice = await sessionFor(ALICE);
    const { projectId, serviceId } = await serviceOf(alice, "gone");
    await addVolume(alice, serviceId, { name: "data", mountPath: "/data" });
    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();

    expect((await call(alice, "DELETE", `/api/projects/${projectId}?deleteData=true`)).status).toBe(204);
    expect(removedVolumes).toEqual([`shipyard-${serviceId}-data`]);
    expect(await prisma.project.count({ where: { id: projectId } })).toBe(0);
  });

  it("only admins manage volumes; viewers can see them; strangers get 404", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const carol = await sessionFor(CAROL);
    const orgId = (await call(alice, "POST", "/api/organizations", { name: "Volume Team" })).body!.data.id as string;
    await call(alice, "POST", `/api/organizations/${orgId}/members`, { login: "bob", role: "DEVELOPER" });
    const { serviceId } = await serviceOf(alice, "team-vol", orgId);
    const volume = (await addVolume(alice, serviceId, { name: "data", mountPath: "/data" })).body!.data;

    expect((await call(bob, "GET", `/api/services/${serviceId}/volumes`)).status).toBe(200);
    expect((await addVolume(bob, serviceId, { name: "more", mountPath: "/more" })).status).toBe(403);
    expect((await call(bob, "DELETE", `/api/volumes/${volume.id}`)).status).toBe(403);
    expect((await call(carol, "GET", `/api/services/${serviceId}/volumes`)).status).toBe(404);
    expect((await call(carol, "DELETE", `/api/volumes/${volume.id}`)).status).toBe(404);
  });

  it("shipyard.yaml adds volumes, and never moves or removes one", async () => {
    const alice = await sessionFor(ALICE);
    repoFiles.set("yaml-vol", "version: 1\nservices:\n  web:\n    volumes:\n      uploads: /app/uploads\n");
    const { projectId, serviceId } = await serviceOf(alice, "yaml-vol");
    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(lastJob?.volumes).toEqual([{ name: `shipyard-${serviceId}-uploads`, mountPath: "/app/uploads" }]);

    repoFiles.set("yaml-vol", "version: 1\nservices:\n  web:\n    volumes:\n      uploads: /srv/uploads\n");
    const second = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    const log = (await call(alice, "GET", `/api/deployments/${second}/logs?type=build`)).body!.data.content as string;
    expect(log).toContain("volume uploads of web stays at /app/uploads");
    expect(await prisma.volume.findMany({ where: { serviceId }, select: { mountPath: true } })).toEqual([{ mountPath: "/app/uploads" }]);
  });
});

describe("PostgreSQL services", () => {
  async function project(cookie: string, repo: string): Promise<string> {
    const res = await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}` });
    expect(res.status).toBe(201);
    return res.body!.data.id as string;
  }
  const addDatabase = (cookie: string, projectId: string, body: object = {}) =>
    call(cookie, "POST", `/api/projects/${projectId}/services`, { name: "db", type: "POSTGRES", ...body });
  const running = (serviceId: string) => prisma.deployment.findMany({ where: { serviceId, status: "RUNNING" } });

  it("adds a database: its own password, a URL for every service, started first, then left alone by project deploys", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await project(alice, "shop-db");
    const created = await addDatabase(alice, projectId);
    expect(created.status).toBe(201);
    expect(created.body!.data).toMatchObject({ name: "db", type: "POSTGRES", image: "postgres:17-alpine", port: 5432, public: false, connectionVariable: "DATABASE_URL" });
    const dbId = created.body!.data.id as string;

    const variables = (await call(alice, "GET", `/api/projects/${projectId}/env`)).body!.data as Array<Record<string, unknown>>;
    expect(variables.map((v) => [v.key, v.serviceId, v.secret, v.value])).toEqual([
      ["DATABASE_URL", null, true, null],
      ["POSTGRES_PASSWORD", dbId, true, null],
    ]);
    expect(await prisma.volume.findMany({ where: { serviceId: dbId }, select: { name: true, mountPath: true } })).toEqual([
      { name: "data", mountPath: "/var/lib/postgresql/data" },
    ]);

    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(jobs.map((job) => job.service?.alias)).toEqual(["db", "web"]);
    const [dbJob, webJob] = jobs;
    expect(dbJob!.service).toMatchObject({ type: "POSTGRES", image: { name: "postgres:17-alpine" }, environment: { POSTGRES_USER: "app", POSTGRES_DB: "app" }, stopFirst: true });
    expect(dbJob!.volumes).toEqual([{ name: `shipyard-${dbId}-data`, mountPath: "/var/lib/postgresql/data" }]);
    const password = dbJob!.env!.runtime.POSTGRES_PASSWORD!;
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(webJob!.env!.runtime.DATABASE_URL).toBe(`postgres://app:${password}@db:5432/app`);
    expect(webJob!.env!.runtime.POSTGRES_PASSWORD).toBeUndefined(); // only the database gets it
    expect(webJob!.env!.build.DATABASE_URL).toBeUndefined(); // secrets never reach a build

    // A push or "Deploy" redeploys the apps, never restarts the database as a side effect.
    jobs.length = 0;
    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(jobs.map((job) => job.service?.alias)).toEqual(["web"]);
    expect(await running(dbId)).toHaveLength(1);

    // A second database gets its own variable.
    const analytics = await addDatabase(alice, projectId, { name: "analytics", version: 16 });
    expect(analytics.body!.data).toMatchObject({ image: "postgres:16-alpine", connectionVariable: "ANALYTICS_DATABASE_URL" });
  });

  it("redeploying a database stops the old server first, and brings it back if the new one fails", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await project(alice, "stop-first");
    const dbId = (await addDatabase(alice, projectId)).body!.data.id as string;
    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    const [first] = await running(dbId);

    engineEvents.length = 0;
    await call(alice, "POST", `/api/services/${dbId}/deploy`);
    await deployments.waitForIdle();
    expect(engineEvents).toEqual([`stop:${first!.containerId}`, "run:db"]); // never two servers on one data directory
    const [second] = await running(dbId);
    expect(second!.id).not.toBe(first!.id);
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe("STOPPED");

    failRuns.add("db");
    engineEvents.length = 0;
    const failed = (await call(alice, "POST", `/api/services/${dbId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    expect(engineEvents).toEqual([`stop:${second!.containerId}`, "run:db", `restart:${second!.containerId}`]);
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: failed } })).status).toBe("FAILED");
    expect((await running(dbId)).map((d) => d.id)).toEqual([second!.id]);
    const events = (await call(alice, "GET", `/api/deployments/${second!.id}/events`)).body!.data as Array<Record<string, unknown>>;
    expect(events.map((e) => e.message)).toContain("Restarted: its replacement failed");

    // Rolling back stops the live server before the old one starts, too.
    failRuns.clear();
    engineEvents.length = 0;
    expect((await call(alice, "POST", `/api/deployments/${second!.id}/rollback`)).status).toBe(200);
    expect(engineEvents).toEqual([`stop:${second!.containerId}`, `restart:${first!.containerId}`]);
  });

  it("validates databases and who may add them", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const projectId = await project(alice, "db-rules");
    for (const body of [{ version: 15 }, { version: "17" }, { sourceDir: "db" }, { public: true }, { name: "Bad_Name" }]) {
      expect({ body, status: (await addDatabase(alice, projectId, body)).status }).toEqual({ body, status: 400 });
    }
    expect((await addDatabase(bob, projectId)).status).toBe(404);
    const db = (await addDatabase(alice, projectId)).body!.data;
    expect((await addDatabase(alice, projectId)).status).toBe(409);
    expect((await call(alice, "PATCH", `/api/services/${db.id}`, { port: 6543 })).status).toBe(400);
    expect((await call(alice, "PATCH", `/api/services/${db.id}`, { memoryLimitMb: 512 })).status).toBe(200);
    // Its storage can't be detached or added to by hand.
    const [data] = (await call(alice, "GET", `/api/services/${db.id}/volumes`)).body!.data as Array<Record<string, any>>;
    expect((await call(alice, "DELETE", `/api/volumes/${data!.id}`)).status).toBe(409);
    expect((await call(alice, "POST", `/api/services/${db.id}/volumes`, { name: "more", mountPath: "/more" })).status).toBe(409);
    // A private service: no domain can point at it.
    expect((await call(alice, "POST", `/api/projects/${projectId}/domains`, { hostname: "db.example.com", serviceId: db.id })).status).toBe(400);
  });

  it("deleting a database needs deleteData=true, and takes its password and URL with it", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await project(alice, "drop-db");
    const db = (await addDatabase(alice, projectId)).body!.data;
    await call(alice, "PUT", `/api/projects/${projectId}/env/API_KEY`, { value: "k" });

    expect((await call(alice, "DELETE", `/api/services/${db.id}`)).status).toBe(409);
    expect((await call(alice, "DELETE", `/api/services/${db.id}?deleteData=true`)).status).toBe(204);
    expect(removedVolumes).toEqual([`shipyard-${db.id}-data`]);
    const keys = (await prisma.environmentVariable.findMany({ where: { projectId }, select: { key: true } })).map((v) => v.key);
    expect(keys).toEqual(["API_KEY"]);
  });

  it("shipyard.yaml declares databases; the version and the kind of a service never change from the file", async () => {
    const alice = await sessionFor(ALICE);
    repoFiles.set("yaml-db", "version: 1\nservices:\n  web: {}\n  db:\n    type: postgres\n    version: 16\n");
    const projectId = await project(alice, "yaml-db");
    const first = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    const db = await prisma.service.findFirstOrThrow({ where: { projectId, name: "db" } });
    expect(db).toMatchObject({ type: "POSTGRES", image: "postgres:16-alpine", managedBy: "CONFIG_FILE" });
    expect(await prisma.environmentVariable.count({ where: { projectId, key: "DATABASE_URL" } })).toBe(1);
    const log = (await call(alice, "GET", `/api/deployments/${first}/logs?type=build`)).body!.data.content as string;
    expect(log).toContain("added database db (PostgreSQL 16); its URL is in DATABASE_URL");

    repoFiles.set("yaml-db", "version: 1\nservices:\n  web: {}\n  db:\n    type: postgres\n    version: 17\n");
    const second = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    expect((await call(alice, "GET", `/api/deployments/${second}/logs?type=build`)).body!.data.content).toContain("db stays on PostgreSQL 16");
    expect((await prisma.service.findUniqueOrThrow({ where: { id: db.id } })).image).toBe("postgres:16-alpine");

    repoFiles.set("yaml-db", "version: 1\nservices:\n  web: {}\n  db:\n    source: db\n");
    const res = await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    expect(res.body!.data).toMatchObject({ status: "FAILED" });
    expect(res.body!.data.errorMessage).toContain(`"db" is a database here; it can't become a web service`);
  });
});

describe("replicas", () => {
  it("runs the number of replicas a service asks for, from the next deploy; never for a database", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/scaled" })).body!.data.id as string;
    const [web] = (await call(alice, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>;
    expect(web!.replicas).toBe(1);

    for (const replicas of [0, 11, 2.5]) {
      expect((await call(alice, "PATCH", `/api/services/${web!.id}`, { replicas })).status).toBe(400);
    }
    expect((await call(alice, "PATCH", `/api/services/${web!.id}`, { replicas: 3 })).status).toBe(200);
    const deployed = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    expect(lastJob?.replicas).toBe(3);
    expect((await call(alice, "GET", `/api/deployments/${deployed}`)).body!.data).toMatchObject({ status: "RUNNING", replicas: 3 });

    const db = (await call(alice, "POST", `/api/projects/${projectId}/services`, { name: "db", type: "POSTGRES" })).body!.data;
    expect((await call(alice, "PATCH", `/api/services/${db.id}`, { replicas: 2 })).status).toBe(400);
    // The database itself refuses it too.
    await expect(prisma.service.update({ where: { id: db.id }, data: { replicas: 2 } })).rejects.toThrow();
  });

  it("shipyard.yaml sets replicas like any other setting", async () => {
    const alice = await sessionFor(ALICE);
    repoFiles.set("yaml-replicas", "version: 1\nservices:\n  web:\n    replicas: 2\n");
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/yaml-replicas" })).body!.data.id;
    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(lastJob?.replicas).toBe(2);
  });
});

describe("cron jobs", () => {
  async function deployedProject(cookie: string, repo: string) {
    const projectId = (await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}` })).body!.data.id as string;
    await call(cookie, "PUT", `/api/projects/${projectId}/env/DATABASE_URL`, { value: "postgres://x", secret: true });
    await call(cookie, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    const [web] = (await call(cookie, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>;
    return { projectId, serviceId: web!.id as string };
  }
  const addJob = (cookie: string, projectId: string, body: object) => call(cookie, "POST", `/api/projects/${projectId}/cron-jobs`, body);

  it("runs a job when it is due, once, in the service's live image, with its variables, on the project network", async () => {
    const alice = await sessionFor(ALICE);
    const { projectId, serviceId } = await deployedProject(alice, "cron-app");
    const created = await addJob(alice, projectId, { name: "cleanup", serviceId, schedule: "0 3 * * *", command: "npm run cleanup" });
    expect(created.status).toBe(201);
    const job = created.body!.data;
    expect(new Date(job.nextRunAt).getUTCHours()).toBe(3);

    // Not due yet: nothing happens.
    expect(await cron.tick(new Date(new Date(job.nextRunAt).getTime() - 60_000))).toBe(0);

    // Due: two ticks at the same moment (two processes, say) start it once.
    const due = new Date(new Date(job.nextRunAt).getTime() + 1_000);
    const started = await Promise.all([cron.tick(due), cron.tick(due)]);
    expect(started[0]! + started[1]!).toBe(1);
    await cron.waitForIdle();

    expect(cronCalls).toHaveLength(1);
    const live = await prisma.deployment.findFirstOrThrow({ where: { serviceId, status: "RUNNING" } });
    expect(cronCalls[0]).toMatchObject({
      imageName: live.imageName,
      command: ["sh", "-c", "npm run cleanup"],
      network: projectNetworkName(projectId),
      env: { DATABASE_URL: "postgres://x" },
      timeoutMs: 3_600_000,
    });
    const runs = (await call(alice, "GET", `/api/cron-jobs/${job.id}/runs`)).body!.data as Array<Record<string, any>>;
    expect(runs).toMatchObject([{ status: "SUCCEEDED", exitCode: 0, trigger: "SCHEDULE", deploymentId: live.id }]);
    expect(runs[0]!.output).toBeUndefined(); // the list leaves output out
    expect((await call(alice, "GET", `/api/cron-runs/${runs[0]!.id}`)).body!.data.output).toBe("cleaned 3 rows\n");

    // The next occurrence is a day later.
    const after = await prisma.cronJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.nextRunAt!.getTime() - new Date(job.nextRunAt).getTime()).toBe(24 * 3_600_000);
  });

  it("records failures, timeouts, and runs it can't start, saying why", async () => {
    const alice = await sessionFor(ALICE);
    const { projectId, serviceId } = await deployedProject(alice, "cron-fail");
    const job = (await addJob(alice, projectId, { name: "report", serviceId, schedule: "@hourly", command: "node report.js", timeoutSeconds: 30 })).body!.data;

    cronResult = { exitCode: 2, timedOut: false, oomKilled: false, output: "Error: no such table\n" };
    await call(alice, "POST", `/api/cron-jobs/${job.id}/run`);
    await cron.waitForIdle();
    cronResult = { exitCode: null, timedOut: true, oomKilled: false, output: "" };
    await call(alice, "POST", `/api/cron-jobs/${job.id}/run`);
    await cron.waitForIdle();

    // A run still going: the next one is skipped, never overlapped.
    cronResult = { exitCode: 0, timedOut: false, oomKilled: false, output: "" };
    let release!: () => void;
    holdCron = new Promise((resolve) => (release = resolve));
    const first = await call(alice, "POST", `/api/cron-jobs/${job.id}/run`);
    expect(first.status).toBe(202);
    expect(first.body!.data.status).toBe("RUNNING");
    const second = await call(alice, "POST", `/api/cron-jobs/${job.id}/run`);
    expect(second.body!.data).toMatchObject({ status: "SKIPPED", errorMessage: "The previous run was still running." });
    release();
    await cron.waitForIdle();

    const runs = (await call(alice, "GET", `/api/cron-jobs/${job.id}/runs`)).body!.data as Array<Record<string, any>>;
    expect(runs.map((r) => [r.status, r.exitCode, r.errorMessage]).reverse()).toEqual([
      ["FAILED", 2, "Exited with code 2."],
      ["TIMED_OUT", null, "Killed after 30s (its timeout)."],
      ["SUCCEEDED", 0, null],
      ["SKIPPED", null, "The previous run was still running."],
    ]);

    // Nothing deployed: skipped, not failed silently.
    const fresh = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/cron-undeployed" })).body!.data.id as string;
    const [web] = (await call(alice, "GET", `/api/projects/${fresh}/services`)).body!.data as Array<Record<string, any>>;
    const idle = (await addJob(alice, fresh, { name: "x", serviceId: web!.id, schedule: "@daily", command: "true" })).body!.data;
    const skipped = await call(alice, "POST", `/api/cron-jobs/${idle.id}/run`);
    expect(skipped.body!.data.errorMessage).toContain("has no running deployment");
  });

  it("validates jobs; admins manage them, developers run them, viewers read; strangers get 404", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const carol = await sessionFor(CAROL);
    const orgId = (await call(alice, "POST", "/api/organizations", { name: "Cron Team" })).body!.data.id as string;
    await call(alice, "POST", `/api/organizations/${orgId}/members`, { login: "bob", role: "DEVELOPER" });
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/cron-team", organizationId: orgId })).body!.data.id as string;
    const [web] = (await call(alice, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>;
    const db = (await call(alice, "POST", `/api/projects/${projectId}/services`, { name: "db", type: "POSTGRES" })).body!.data;

    for (const body of [
      { name: "Bad", serviceId: web!.id, schedule: "@daily", command: "x" },
      { name: "a", serviceId: web!.id, schedule: "every day", command: "x" },
      { name: "a", serviceId: web!.id, schedule: "@daily", command: "a\nb" },
      { name: "a", serviceId: web!.id, schedule: "@daily", command: "x", timeoutSeconds: 5 },
      { name: "a", serviceId: db.id, schedule: "@daily", command: "x" },
      { name: "a", serviceId: "00000000-0000-4000-8000-000000000000", schedule: "@daily", command: "x" },
    ]) {
      expect({ body, status: (await addJob(alice, projectId, body)).status }).toEqual({ body, status: 400 });
    }
    expect((await addJob(bob, projectId, { name: "a", serviceId: web!.id, schedule: "@daily", command: "x" })).status).toBe(403);
    const job = (await addJob(alice, projectId, { name: "a", serviceId: web!.id, schedule: "@daily", command: "x" })).body!.data;
    expect((await addJob(alice, projectId, { name: "a", serviceId: web!.id, schedule: "@daily", command: "x" })).status).toBe(409);

    expect((await call(bob, "GET", `/api/projects/${projectId}/cron-jobs`)).status).toBe(200);
    expect((await call(bob, "POST", `/api/cron-jobs/${job.id}/run`)).status).toBe(202);
    expect((await call(bob, "PATCH", `/api/cron-jobs/${job.id}`, { enabled: false })).status).toBe(403);
    expect((await call(carol, "GET", `/api/cron-jobs/${job.id}/runs`)).status).toBe(404);
    expect((await call(carol, "POST", `/api/cron-jobs/${job.id}/run`)).status).toBe(404);

    // Disabled: never due. Enabled again: due from now on.
    expect((await call(alice, "PATCH", `/api/cron-jobs/${job.id}`, { enabled: false })).body!.data.nextRunAt).toBeNull();
    expect((await call(alice, "PATCH", `/api/cron-jobs/${job.id}`, { enabled: true })).body!.data.nextRunAt).not.toBeNull();
    expect((await call(alice, "DELETE", `/api/cron-jobs/${job.id}`)).status).toBe(204);
    expect(await prisma.auditLog.count({ where: { action: { in: ["CRON_JOB_CREATED", "CRON_JOB_CHANGED", "CRON_JOB_DELETED", "CRON_JOB_RUN"] } } })).toBe(5);
  });

  it("a run interrupted by a restart is marked FAILED at startup", async () => {
    const alice = await sessionFor(ALICE);
    const { projectId, serviceId } = await deployedProject(alice, "cron-restart");
    const job = (await addJob(alice, projectId, { name: "slow", serviceId, schedule: "@daily", command: "sleep 100" })).body!.data;
    await prisma.cronRun.create({ data: { cronJobId: job.id, status: "RUNNING", containerName: "shipyard-x" } });
    expect(await cron.reconcileOnStartup()).toBe(1);
    expect(await prisma.cronRun.findFirstOrThrow({ where: { cronJobId: job.id } })).toMatchObject({
      status: "FAILED",
      errorMessage: "Interrupted: Shipyard restarted while it ran.",
    });
  });

  it("shipyard.yaml declares cron jobs", async () => {
    const alice = await sessionFor(ALICE);
    repoFiles.set("yaml-cron", 'version: 1\nservices:\n  web: {}\ncron:\n  cleanup:\n    schedule: "0 0 * * *"\n    command: npm run cleanup\n');
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/yaml-cron" })).body!.data.id as string;
    const first = (await call(alice, "POST", `/api/projects/${projectId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();
    const jobs = (await call(alice, "GET", `/api/projects/${projectId}/cron-jobs`)).body!.data as Array<Record<string, any>>;
    expect(jobs).toMatchObject([{ name: "cleanup", serviceName: "web", schedule: "0 0 * * *", command: "npm run cleanup", managedBy: "CONFIG_FILE", enabled: true }]);
    expect((await call(alice, "GET", `/api/deployments/${first}/logs?type=build`)).body!.data.content).toContain("added cron job cleanup (0 0 * * *)");

    repoFiles.set("yaml-cron", 'version: 1\nservices:\n  web: {}\ncron:\n  cleanup:\n    schedule: "@hourly"\n    command: npm run cleanup\n');
    await call(alice, "PATCH", `/api/cron-jobs/${jobs[0]!.id}`, { enabled: false }); // a dashboard decision the file leaves alone
    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    expect(await prisma.cronJob.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).toMatchObject({ schedule: "@hourly", enabled: false, nextRunAt: null });
  });
});

/** A signed GitHub delivery, as GitHub would send it. */
async function deliverWebhook(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${api}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signGitHubPayload(WEBHOOK_SECRET, body),
    },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("environments", () => {
  async function stack(cookie: string, repo: string) {
    const projectId = (await call(cookie, "POST", "/api/projects", { repositoryUrl: `https://github.com/acme/${repo}` })).body!.data.id as string;
    await call(cookie, "POST", `/api/projects/${projectId}/services`, { name: "db", type: "POSTGRES" });
    await call(cookie, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();
    return projectId;
  }

  it("a development environment runs the apps from another branch at dev-<slug>, next to production", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = await stack(alice, "shop");
    await call(alice, "PUT", `/api/projects/${projectId}/env/LOG_LEVEL`, { value: "info" });
    await call(alice, "PUT", `/api/projects/${projectId}/env/LOG_LEVEL?environment=DEVELOPMENT`, { value: "debug" });

    expect((await call(alice, "POST", `/api/projects/${projectId}/environments`, { type: "DEVELOPMENT", branch: "main" })).status).toBe(400);
    expect((await call(alice, "POST", `/api/projects/${projectId}/environments`, { type: "DEVELOPMENT", branch: "--force" })).status).toBe(400);
    const created = await call(alice, "POST", `/api/projects/${projectId}/environments`, { type: "DEVELOPMENT", branch: "develop" });
    expect(created.status).toBe(201);
    const devId = created.body!.data.id as string;
    expect(created.body!.data).toMatchObject({ type: "DEVELOPMENT", name: "dev", branch: "develop", status: "ACTIVE" });
    expect((await call(alice, "POST", `/api/projects/${projectId}/environments`, { type: "DEVELOPMENT", branch: "next" })).status).toBe(409);

    // Deploying it doesn't block production: each environment has its own deploy lock.
    jobs.length = 0;
    let release!: () => void;
    holdRuns = new Promise((resolve) => (release = resolve));
    const devDeploy = await call(alice, "POST", `/api/environments/${devId}/deploy`);
    expect(devDeploy.status).toBe(202);
    expect((await call(alice, "POST", `/api/projects/${projectId}/deploy`)).status).toBe(202);
    release();
    holdRuns = null;
    await deployments.waitForIdle();

    const devJob = jobs.find((job) => job.routeName === "dev-shop")!;
    expect(devJob).toMatchObject({ branch: "develop", replicas: 1, volumes: [], domains: [] });
    expect(devJob.env!.runtime.LOG_LEVEL).toBe("debug");
    expect(devJob.env!.runtime.DATABASE_URL).toBeDefined(); // not a preview: production's ALL secrets apply
    expect(jobs.filter((job) => job.service?.type === "POSTGRES")).toEqual([]); // the database is production's
    expect(liveRoutes.get("dev-shop")).toBe(devDeploy.body!.data.id);
    expect(liveRoutes.get("shop")).toBeDefined(); // production still live

    const dev = await prisma.deployment.findUniqueOrThrow({ where: { id: devDeploy.body!.data.id } });
    expect(dev).toMatchObject({ environmentId: devId, status: "RUNNING", branch: "develop" });
    // Production's history and services ignore it.
    const services = (await call(alice, "GET", `/api/projects/${projectId}/services`)).body!.data as Array<Record<string, any>>;
    expect(services.find((service) => service.name === "web")!.latestDeployment.environmentId).toBeNull();

    // A push to develop deploys the development environment, not production.
    jobs.length = 0;
    const pushed = await deliverWebhook("push", {
      ref: "refs/heads/develop",
      after: "d".repeat(40),
      repository: { name: "shop", owner: { login: "acme" } },
    });
    expect(pushed.body.data.outcome).toContain("deploying dev-shop");
    await deployments.waitForIdle();
    expect(jobs.map((job) => job.routeName)).toEqual(["dev-shop"]);

    const listed = (await call(alice, "GET", `/api/projects/${projectId}/environments`)).body!.data as Array<Record<string, any>>;
    expect(listed).toMatchObject([{ id: devId, name: "dev", deployments: [{ status: "RUNNING" }] }]);
  });

  it("closing an environment removes its containers and route, keeps its history, and refuses further deploys", async () => {
    const alice = await sessionFor(ALICE);
    const bob = await sessionFor(BOB);
    const projectId = await stack(alice, "closing");
    const devId = (await call(alice, "POST", `/api/projects/${projectId}/environments`, { type: "DEVELOPMENT", branch: "develop" })).body!.data.id;
    const deployed = (await call(alice, "POST", `/api/environments/${devId}/deploy`)).body!.data.id as string;
    await deployments.waitForIdle();

    expect((await call(bob, "POST", `/api/environments/${devId}/close`)).status).toBe(404);
    const closed = await call(alice, "POST", `/api/environments/${devId}/close`);
    expect(closed.body!.data).toMatchObject({ status: "CLOSED" });
    expect(destroyedDeployments).toContain(deployed);
    expect(liveRoutes.has("dev-closing")).toBe(false);
    expect(liveRoutes.has("closing")).toBe(true);
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: deployed } })).status).toBe("STOPPED");
    expect((await call(alice, "POST", `/api/environments/${devId}/deploy`)).status).toBe(409);
    expect((await call(alice, "POST", `/api/deployments/${deployed}/restart`)).status).toBe(409);
    expect((await call(alice, "POST", `/api/environments/${devId}/close`)).status).toBe(200); // idempotent

    // Reopening keeps the name and takes a branch.
    const reopened = await call(alice, "POST", `/api/projects/${projectId}/environments`, { type: "DEVELOPMENT", branch: "staging" });
    expect(reopened.body!.data).toMatchObject({ id: devId, status: "ACTIVE", branch: "staging" });
  });

  it("variables per environment: a production secret never reaches a preview", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/vars-env" })).body!.data.id as string;
    await call(alice, "PUT", `/api/projects/${projectId}/env/STRIPE_KEY`, { value: "sk_live", secret: true });
    await call(alice, "PUT", `/api/projects/${projectId}/env/API_URL`, { value: "https://api.example.com" });
    await call(alice, "PUT", `/api/projects/${projectId}/env/STRIPE_KEY?environment=PREVIEW`, { value: "sk_test", secret: true });
    await call(alice, "PUT", `/api/projects/${projectId}/env/ONLY_PROD?environment=PRODUCTION`, { value: "1" });
    await call(alice, "PUT", `/api/projects/${projectId}/env/SENTRY_DSN`, { value: "dsn", secret: true });
    expect((await call(alice, "PUT", `/api/projects/${projectId}/env/X?environment=STAGING`, { value: "1" })).status).toBe(400);

    const listed = (await call(alice, "GET", `/api/projects/${projectId}/env`)).body!.data as Array<Record<string, any>>;
    expect(listed.filter((v) => v.key === "STRIPE_KEY").map((v) => v.environment)).toEqual(["ALL", "PREVIEW"]);

    expect((await environment.forDeployment(projectId, undefined, "PRODUCTION")).runtime).toEqual({
      STRIPE_KEY: "sk_live",
      API_URL: "https://api.example.com",
      ONLY_PROD: "1",
      SENTRY_DSN: "dsn",
    });
    // Previews: non-secret ALL values, and only the secrets set for PREVIEW.
    expect((await environment.forDeployment(projectId, undefined, "PREVIEW")).runtime).toEqual({
      STRIPE_KEY: "sk_test",
      API_URL: "https://api.example.com",
    });

    // Copying the production ciphertext into a preview row doesn't decrypt there.
    const live = await prisma.environmentVariable.findFirstOrThrow({ where: { projectId, key: "STRIPE_KEY", environment: "ALL" } });
    await prisma.environmentVariable.updateMany({ where: { projectId, key: "STRIPE_KEY", environment: "PREVIEW" }, data: { value: live.value } });
    await expect(environment.forDeployment(projectId, undefined, "PREVIEW")).rejects.toThrow("can't be decrypted");

    expect((await call(alice, "DELETE", `/api/projects/${projectId}/env/STRIPE_KEY?environment=PREVIEW`)).status).toBe(204);
    expect(await prisma.environmentVariable.count({ where: { projectId, key: "STRIPE_KEY" } })).toBe(1);
  });

  it("keeps dev- and pr-<n>- addresses for environments", async () => {
    const alice = await sessionFor(ALICE);
    expect((await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/dev-tools" })).status).toBe(400);
    expect((await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/pr-12-site" })).status).toBe(400);
    expect((await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/devtools" })).status).toBe(201);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/names" })).body!.data.id;
    for (const name of ["dev", "pr-3", "dev-api", "pr-1-x"]) {
      expect({ name, status: (await call(alice, "POST", `/api/projects/${projectId}/services`, { name })).status }).toEqual({ name, status: 400 });
    }
  });
});

describe("pull request previews", () => {
  const pr = (action: string, number: number, extra: { head?: string; base?: string; fork?: boolean; title?: string } = {}) => ({
    action,
    number,
    pull_request: {
      title: extra.title ?? "Soil alerts",
      head: { ref: extra.head ?? "feature/alerts", repo: { full_name: extra.fork ? "mallory/preview-shop" : "acme/preview-shop" } },
      base: { ref: extra.base ?? "main", repo: { full_name: "acme/preview-shop" } },
    },
    repository: { name: "preview-shop", owner: { login: "acme" } },
  });

  it("opens, updates and closes a preview at pr-<n>-<slug>, without production secrets or the database", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/preview-shop" })).body!.data.id as string;
    await call(alice, "POST", `/api/projects/${projectId}/services`, { name: "db", type: "POSTGRES" });
    await call(alice, "PUT", `/api/projects/${projectId}/env/STRIPE_KEY`, { value: "sk_live", secret: true });
    await call(alice, "PUT", `/api/projects/${projectId}/env/STRIPE_KEY?environment=PREVIEW`, { value: "sk_test", secret: true });
    await call(alice, "POST", `/api/projects/${projectId}/deploy`);
    await deployments.waitForIdle();

    // Off by default.
    expect((await deliverWebhook("pull_request", pr("opened", 7))).body.data.outcome).toContain("ignored: no project previews");
    expect((await call(alice, "PATCH", `/api/projects/${projectId}`, { previewDeployments: true })).status).toBe(200);

    jobs.length = 0;
    const opened = await deliverWebhook("pull_request", pr("opened", 7));
    expect(opened.body.data.outcome).toContain("deploying pr-7-preview-shop");
    await deployments.waitForIdle();
    expect(jobs.map((job) => job.routeName)).toEqual(["pr-7-preview-shop"]); // web only: no database
    const [job] = jobs;
    expect(job).toMatchObject({ branch: "feature/alerts", volumes: [], domains: [] });
    expect(job!.env!.runtime.STRIPE_KEY).toBe("sk_test");
    expect(job!.env!.runtime.DATABASE_URL).toBeUndefined(); // a production secret
    const preview = await prisma.environment.findFirstOrThrow({ where: { projectId, name: "pr-7" } });
    expect(preview).toMatchObject({ type: "PREVIEW", pullRequest: 7, title: "Soil alerts", status: "ACTIVE" });
    const first = liveRoutes.get("pr-7-preview-shop");
    expect(first).toBeDefined();

    // New commits redeploy it; a new title is recorded.
    await deliverWebhook("pull_request", pr("synchronize", 7));
    await deployments.waitForIdle();
    expect(liveRoutes.get("pr-7-preview-shop")).not.toBe(first);
    await deliverWebhook("pull_request", pr("edited", 7, { title: "Soil moisture alerts" }));
    expect((await prisma.environment.findUniqueOrThrow({ where: { id: preview.id } })).title).toBe("Soil moisture alerts");

    // Closing (or merging) takes it down; production is untouched.
    const closed = await deliverWebhook("pull_request", pr("closed", 7));
    expect(closed.body.data.outcome).toContain("closed pr-7-preview-shop");
    expect(liveRoutes.has("pr-7-preview-shop")).toBe(false);
    expect(liveRoutes.has("preview-shop")).toBe(true);
    expect((await prisma.environment.findUniqueOrThrow({ where: { id: preview.id } })).status).toBe("CLOSED");

    // Reopened: back, same environment.
    await deliverWebhook("pull_request", pr("reopened", 7));
    await deployments.waitForIdle();
    expect((await prisma.environment.findUniqueOrThrow({ where: { id: preview.id } })).status).toBe("ACTIVE");
  });

  it("never builds forks, and only previews pull requests into the project's branch", async () => {
    const alice = await sessionFor(ALICE);
    const projectId = (await call(alice, "POST", "/api/projects", { repositoryUrl: "https://github.com/acme/preview-shop" })).body!.data.id as string;
    await call(alice, "PATCH", `/api/projects/${projectId}`, { previewDeployments: true });
    jobs.length = 0;
    expect((await deliverWebhook("pull_request", pr("opened", 8, { fork: true }))).body.data.outcome).toBe("ignored: pull requests from forks are never built");
    expect((await deliverWebhook("pull_request", pr("opened", 9, { base: "release" }))).body.data.outcome).toContain("ignored");
    expect((await deliverWebhook("pull_request", pr("opened", 10, { head: "--upload-pack=x" }))).body.data.outcome).toContain("isn't one Shipyard builds");
    await deployments.waitForIdle();
    expect(jobs).toEqual([]);
    expect(await prisma.environment.count({ where: { projectId } })).toBe(0);
  });
});

describe("workers", () => {
  const info = { name: "builder-1", hostname: "builder-1.internal", cpus: 8, memoryMb: 16_384, version: "4.0.0" };
  async function workerCall(method: string, path: string, token: string | null, body?: unknown) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as Record<string, any>) };
  }

  it("registers with the join token, gets its own secret once, heartbeats with it", async () => {
    expect((await workerCall("POST", "/api/workers/register", null, info)).status).toBe(401);
    expect((await workerCall("POST", "/api/workers/register", "x".repeat(48), info)).status).toBe(401);
    expect((await workerCall("POST", "/api/workers/register", WORKER_JOIN_TOKEN, { ...info, name: "Bad Name" })).status).toBe(400);

    const registered = await workerCall("POST", "/api/workers/register", WORKER_JOIN_TOKEN, info);
    expect(registered.status).toBe(201);
    const { worker, token, heartbeatIntervalMs } = registered.body!.data;
    expect(token).toMatch(/^shpw_[A-Za-z0-9_-]{43}$/);
    expect(heartbeatIntervalMs).toBeGreaterThan(0);
    expect(worker).toMatchObject({ name: "builder-1", status: "ONLINE", cpus: 8, builtIn: false });
    expect(worker.tokenHash).toBeUndefined();
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } })).tokenHash).not.toContain(token);

    const beat = await workerCall("POST", `/api/workers/${worker.id}/heartbeat`, token, { runningJobs: 2 });
    expect(beat.status).toBe(200);
    expect(beat.body!.data).toMatchObject({ runningJobs: 2, status: "ONLINE" });

    // Its secret works for it only; re-registering replaces it.
    const other = (await workerCall("POST", "/api/workers/register", WORKER_JOIN_TOKEN, { ...info, name: "builder-2" })).body!.data;
    expect((await workerCall("POST", `/api/workers/${other.worker.id}/heartbeat`, token, { runningJobs: 0 })).status).toBe(401);
    const again = (await workerCall("POST", "/api/workers/register", WORKER_JOIN_TOKEN, info)).body!.data;
    expect(again.worker.id).toBe(worker.id);
    expect((await workerCall("POST", `/api/workers/${worker.id}/heartbeat`, token, { runningJobs: 0 })).status).toBe(401);
    expect((await workerCall("POST", `/api/workers/${worker.id}/heartbeat`, again.token, { runningJobs: 0 })).status).toBe(200);

    // A user's API key or session is not a worker secret.
    const alice = await sessionFor(ALICE);
    expect((await call(alice, "POST", `/api/workers/${worker.id}/heartbeat`, { runningJobs: 0 })).status).toBe(401);
  });

  it("goes OFFLINE when heartbeats stop, and comes back with the next one", async () => {
    const { worker, token } = (await workerCall("POST", "/api/workers/register", WORKER_JOIN_TOKEN, info)).body!.data;
    expect(await workers.sweep(new Date(Date.now() + 10_000))).toEqual([]);
    expect(await workers.sweep(new Date(Date.now() + 60_000))).toEqual([worker.id]);
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe("OFFLINE");
    await workerCall("POST", `/api/workers/${worker.id}/heartbeat`, token, { runningJobs: 0 });
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe("ONLINE");
    expect((await workerCall("POST", `/api/workers/${worker.id}/disconnect`, token)).status).toBe(204);
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe("OFFLINE");
  });

  it("platform admins list and drain workers; a draining worker stays draining through heartbeats", async () => {
    const alice = await sessionFor(ALICE); // in SHIPYARD_ADMINS
    const bob = await sessionFor(BOB);
    const builtIn = await workers.registerBuiltIn({ ...info, name: "control-plane" });
    const { worker, token } = (await workerCall("POST", "/api/workers/register", WORKER_JOIN_TOKEN, info)).body!.data;

    expect((await call(bob, "GET", "/api/workers")).status).toBe(403);
    expect((await call(bob, "POST", `/api/workers/${worker.id}/drain`)).status).toBe(403);
    const listed = (await call(alice, "GET", "/api/workers")).body!.data as Array<Record<string, any>>;
    expect(listed.map((w) => [w.name, w.builtIn])).toEqual([["control-plane", true], ["builder-1", false]]);
    expect(listed.every((w) => w.tokenHash === undefined)).toBe(true);

    expect((await call(alice, "POST", `/api/workers/${worker.id}/drain`)).body!.data.status).toBe("DRAINING");
    await workerCall("POST", `/api/workers/${worker.id}/heartbeat`, token, { runningJobs: 1 });
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe("DRAINING");
    expect((await call(alice, "POST", `/api/workers/${worker.id}/undrain`)).body!.data.status).toBe("ONLINE");

    // Nobody can take the control plane's own name.
    expect((await workerCall("POST", "/api/workers/register", WORKER_JOIN_TOKEN, { ...info, name: builtIn.name })).status).toBe(403);
  });
});
