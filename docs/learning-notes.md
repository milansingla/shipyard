# Learning notes

One section per milestone. Read the code paths listed — don't just memorize answers.

---

## Milestone 1 — TypeScript foundation

### Understand Before Interview

#### Key concepts

1. **Composition root / dependency injection** — objects are built in one place
   (`bootstrap.ts`) and passed into constructors. Makes tests use fakes without
   mocking libraries.
2. **State machine** — a deployment can only move along declared transitions
   (`status.ts`). Illegal moves throw instead of silently corrupting history.
3. **Liveness vs. readiness** — "container is running" (liveness of a process)
   is not "app is serving" (readiness). Shipyard probes over HTTP.
4. **Docker log multiplexing** — non-TTY containers interleave stdout/stderr in
   frames with an 8-byte header: `[type][0 0 0][uint32 size]`.
5. **Docker build errors are in-band** — a failing `RUN` appears as an
   `errorDetail` event in the progress stream, not as a stream error.
6. **No shell = no shell injection** — `execFile("git", [args])` passes args
   straight to the program. `exec("git clone " + url)` lets `; rm -rf ~` run.
7. **Argument injection** — even without a shell, a value starting with `-` can
   be parsed as a flag. Fix: validate, and put `--` before positional args.
8. **Docker labels as metadata** — key/value pairs on containers/images let
   Shipyard find and *own* its resources.
9. **Ephemeral port publishing** — `HostPort: ""` lets Docker pick a free port;
   it can change after a restart, so re-inspect.
10. **ESM + NodeNext** — TypeScript imports end in `.js` because they must match
    the compiled output Node actually loads.

#### Likely interview questions

**Why is a RUNNING container different from a HEALTHY application?**
Docker only knows the process exists. The app may still be booting, may have
crashed after start, or may listen on `127.0.0.1` inside the container (so
nothing outside can reach it). Only a real request proves it serves traffic.
Code: `HealthCheckService.waitUntilHealthy`.

**Why treat HTTP 404 as healthy?**
The check asks "is a server listening and responding?" not "does `/` exist?".
Many APIs have no root route. 5xx means the server is up but broken, so it
doesn't count. Trade-off: a configurable health path is more precise (planned).

**Why separate DeploymentService and DockerService?**
Different reasons to change. DeploymentService encodes the process (order,
statuses, failure policy); DockerService encodes how to talk to Docker. The
split lets the process be unit-tested with a fake Docker
(`deploymentService.test.ts`) and lets Docker code be integration-tested alone.

**Why Dockerode instead of shelling out to the `docker` CLI?**
Typed, structured responses (JSON, not parsed text); streaming build events;
no shell escaping concerns; no dependency on the CLI being installed in the API
image. Trade-off: Dockerode's types lag behind the API, and Docker Engine API
semantics (e.g. in-band build errors) must be learned directly.

**Why do we still shell out to `git` then?**
Git's network protocol and auth are complex; the `git` binary is the
reference implementation. JS reimplementations (isomorphic-git) are slower and
less complete. We call it safely: `execFile`, validated input, `--`, hardening
`-c` flags, timeout.

**How do you prevent command injection with user-supplied repo URLs?**
Layers: (1) parse with `URL`, allow only `https://<allowlisted-host>/<owner>/<repo>`;
(2) `execFile` with an args array, never a shell; (3) `--` before the URL;
(4) `protocol.allow=never` so redirects can't switch transport.

**What happens when a deployment fails halfway?**
Status → `FAILED`, `errorMessage` stored, the clone directory is deleted in a
`finally`, and if a container was started its last 50 log lines are captured and
it is stopped (not removed) so you can inspect it. The original error is
rethrown wrapped in `DeploymentFailedError` carrying the record — never swallowed.

**Why bind published ports to 127.0.0.1?**
`0.0.0.0` exposes every deployed app to the local network/Internet. Until a
reverse proxy (Traefik) is the single entry point, loopback is the safe default.

**Why validate env vars with Zod at startup?**
Fail fast with a clear message instead of a mysterious crash later
(`PORT=abc` → `NaN`). One typed `AppConfig` object instead of `process.env`
scattered everywhere.

#### Important code paths

- `DeploymentService.deploy` — the whole pipeline in ~80 lines
- `DockerService.buildImage` — build streaming + in-band error detection
- `HealthCheckService.waitUntilHealthy` — the readiness loop
- `GitService.clone` — hardened git invocation
- `status.ts` — the transition table

#### Trade-offs to be able to defend

| Decision                          | Alternative               | Why this, for now                           |
| --------------------------------- | ------------------------- | ------------------------------------------- |
| Deploy runs inside the request/CLI process | Job queue (Redis/BullMQ) | Simpler; one host; revisit when deploys must survive restarts |
| Keep failed containers (stopped)  | Remove immediately        | Logs stay inspectable; cleanup job later     |
| Clone deleted after build         | Keep for cache            | Disk safety; build cache lives in Docker     |
| Port from `EXPOSE`, default 3000  | Require config            | Works for most Node apps; config comes in M2/M3 |
| npm workspaces                    | pnpm / Turborepo          | Zero extra tooling; enough for 2–3 packages  |
| Vitest                            | Jest                      | Native ESM + TypeScript, no transform config |

---

## Milestone 3 — Node.js detection + Dockerfile generation

### Understand Before Interview

#### Key concepts

1. **Detection is pure, generation is pure, writing is isolated** —
   `nodeProject.ts` only reads, `generateDockerfile.ts` is a string function,
   and `prepareBuild.ts` is the one place that writes into the clone. Each is
   testable alone.
2. **The user's Dockerfile always wins** — generation is a fallback, never an
   override. Same principle as Heroku/Railway buildpacks.
3. **Exec form vs shell form** — `CMD ["node","server.js"]` runs the program
   directly; `CMD node server.js` runs `/bin/sh -c "…"`. Exec form means a
   repository-supplied filename can't become a shell command.
4. **Corepack** — Node's shim that installs the exact pnpm/yarn version named
   in `package.json` `"packageManager"`, so builds don't depend on whatever
   version happens to be in the image.
5. **`npm ci` vs `npm install`** — `ci` installs exactly the lockfile and fails
   if it disagrees with `package.json`; reproducible builds need it.
6. **`.dockerignore` is a client-side feature** — the docker CLI filters the
   context before uploading. A program that uploads the context itself (via
   the Engine API) must apply it itself, or excluded files leak into images.
7. **O_EXCL / `"wx"`** — create-only-if-absent, atomically, and it refuses to
   follow a symlink. The standard defence against symlink-planting attacks.
8. **semver range intersection** — `engines.node: ">=18"` intersects `^24`, so
   Node 24 satisfies it; `"16.x"` intersects none of 20/22/24 → error.

#### Likely interview questions

**How does Shipyard decide how to build a repo without a Dockerfile?**
`prepareBuild`: Dockerfile present → use it. Else `package.json` → detect
package manager (corepack field, then lockfile), Node version (`engines.node`),
build script, start command → generate a Dockerfile. Else fail with a clear
message. Code: `services/build/prepareBuild.ts`.

**Why fail instead of guessing when there's no start command?**
A wrong guess builds an image that crashes at runtime, and the error then
looks like the user's bug. Failing at detection with "add a start script"
points straight at the fix. Correctness over magic.

**Could a malicious package.json inject commands into the generated Dockerfile?**
Every `RUN` line is a fixed template. The only repo-derived value that reaches
the Dockerfile is the start file (`main`), which must match a strict path regex
(no `..`, spaces, `$`, newlines) and is emitted with `JSON.stringify` in exec
form. And even without that, a Dockerfile already runs arbitrary repository
code (`npm install` runs install scripts) — so the real boundary is the
container, not the Dockerfile text. Tests: `nodeProject.test.ts`,
`generateDockerfile.test.ts`.

**Why `node:24-slim` and not `node:24-alpine`?**
Alpine uses musl libc; many native npm modules (sharp, bcrypt, Prisma engines)
ship glibc binaries or need extra build tools on Alpine. Slim is bigger but
works for far more apps. For a generic generator, compatibility beats size.

**Why run as the `node` user?**
Install scripts and the app are untrusted code. As root inside the container,
a kernel/Docker escape is far more dangerous and the app can modify anything
in the image. The official image ships an unprivileged `node` user.

**How did you discover the .dockerignore bug?**
By testing the assumption against a real daemon: built a context with
`node_modules/marker` excluded by `.dockerignore`, ran `find` in the image —
the file was there. Fixed client-side, and added an integration test asserting
a `.dockerignore`d `secret.txt` is absent from the running container.

#### Important code paths

- `prepareBuild` — repository Dockerfile vs generated vs fail
- `detectNodeProject` — package manager, Node version, start command
- `generateNodeDockerfile` / `installCommand` — the template
- `createContextFilter` — `.dockerignore` semantics

#### Trade-offs to be able to defend

| Decision                               | Alternative                     | Why this, for now                                        |
| -------------------------------------- | ------------------------------- | -------------------------------------------------------- |
| `COPY . .` before install              | Copy manifests first for caching | Correct for postinstall scripts and workspaces; caching is a V4 concern |
| Keep devDependencies in the image      | Prune after build               | Prune commands differ per manager; correctness first      |
| Fixed port 3000 for generated builds   | Parse source for `listen()`     | Static analysis is unreliable; `PORT` env is the convention |
| Hand-written generator                 | Cloud Native Buildpacks / Nixpacks | No extra build toolchain; small and explainable; easy to swap later |
| `semver` dependency                    | Hand-parse ranges               | Range semantics are subtle; npm itself uses this library  |

---

## Milestone 4 — GitHub sign-in, ownership, repository selection

### Understand Before Interview

#### Key concepts

1. **Authentication vs authorization** — *who are you* (GitHub sign-in →
   session) vs *what may you do* (`ownerId` scoping in every service query).
2. **OAuth 2.0 authorization-code flow** — the browser only ever carries a
   short-lived `code`; the server swaps it for a token using its client secret.
3. **`state`** — a per-attempt random value, bound to the browser by an
   httpOnly cookie. Without it, an attacker can log *you* into *their* account
   (login CSRF).
4. **PKCE** — the server keeps a random `verifier` and sends only
   `sha256(verifier)`. A stolen `code` is useless without the verifier.
5. **Server-side sessions** — the cookie is a random token; the DB stores its
   hash. Logout deletes the row, so it works instantly (unlike a stateless JWT).
6. **Cookie flags** — `HttpOnly` (no JS access), `SameSite=Lax` (not sent on
   cross-site POSTs), `Secure` (HTTPS only), `__Host-` prefix (no Domain, Path=/).
7. **CSRF** — a malicious page making *your* browser send an authenticated
   request. Defence in depth: SameSite + checking `Origin` on state-changing requests.
8. **IDOR** (insecure direct object reference) — `GET /deployments/:id` for
   someone else's id. Fix: scope the query (`WHERE project.ownerId = me`), return 404.
9. **Authenticated encryption (AES-GCM)** — confidentiality *and* tamper
   detection; a unique IV per message.
10. **Allowlisting identities** — on a platform that runs code, "can sign in"
    must mean "trusted", so sign-in itself is restricted.

#### Likely interview questions

**Why sessions in PostgreSQL instead of JWTs?**
Revocation. A JWT is valid until it expires; logging out or removing a user
can't kill it without a denylist — which is a session table again. One
indexed lookup per request is cheap at this scale. Code: `AuthService.authenticate`.

**Why store a hash of the session token instead of the token?**
Same reason as passwords: a leaked DB backup must not let anyone impersonate
users. The token has 256 bits of entropy, so a plain SHA-256 is enough (no
slow KDF needed — there's nothing to brute-force).

**Why 404 instead of 403 for another user's project?**
403 confirms the id exists. 404 reveals nothing. The service query simply
doesn't find it: `findFirst({ where: { id, ownerId } })`.

**Where is authorization enforced?**
In the services, not only the routes: `ProjectService.get(id, ownerId)`,
`DeploymentService.get(id, ownerId)`. A future caller (webhooks, CLI) can't
forget it, because there is no unscoped public method. Tested endpoint by
endpoint in `api.integration.test.ts`.

**What does PKCE add if you already have a client secret?**
Defence in depth for the code: if it leaks (logs, referrer, a malicious
browser extension), it can't be redeemed without the verifier that never left
the server and this browser's cookie. GitHub supports it, so it costs nothing.

**Why encrypt the GitHub token if the database is "internal"?**
Backups, replicas, dumps, `db:studio` screenshots. Encryption with a key that
lives only in the API's environment means a DB-only leak isn't a GitHub leak.

**Why the sign-in allowlist?**
A GitHub OAuth App accepts *any* GitHub account. On Shipyard, signing in means
being able to run code on the host. So who may sign in is required config, and
re-checked on every request so removal is immediate.

**How did you test OAuth without GitHub?**
A ~60-line fake GitHub HTTP server in the integration test that implements
the token endpoint for real — single-use codes, and it rejects a wrong PKCE
verifier — plus `/user`, repos and branches. The real `GitHubClient`,
`AuthService`, Express app and PostgreSQL are used.

#### Important code paths

- `AuthService.startLogin` / `completeLogin` / `authenticate`
- `middleware/authenticate.ts` (`requireUser`), `middleware/originCheck.ts`
- `ProjectService` / `DeploymentService` — every public method takes `ownerId`
- `lib/secretBox.ts` — AES-256-GCM
- `test/integration/api.integration.test.ts` — the authorization matrix

#### Trade-offs to be able to defend

| Decision                          | Alternative                    | Why this, for now                                   |
| --------------------------------- | ------------------------------ | --------------------------------------------------- |
| DB sessions                       | JWT                            | Instant revocation; one indexed query               |
| OAuth App, `read:user`            | GitHub App                     | Simple sign-in; private repos (GitHub App) later     |
| Fixed session lifetime            | Sliding expiry                 | No write per request; good enough for 30 days        |
| Owner = single user               | Teams/RBAC                     | V4 scope; ownership column is the seam for it        |
| Hand-rolled 15-line cookie reader | `cookie-parser`                | One function, fully tested; setting uses Express     |
| Login allowlist by `login`        | By numeric id                  | Readable config; logins re-checked each request      |

---

## Milestone 5 — Next.js dashboard

### Understand Before Interview

#### Key concepts

1. **Same-origin via a reverse-proxy rewrite** — the dashboard serves pages and
   forwards `/api/*` to the API. The browser sees one origin: no CORS, cookies
   stay first-party, CSRF checks unchanged.
2. **Thin client** — the UI renders what the API returns; authorization and
   state rules live only in the API. A UI bug can't grant access.
3. **Polling with a stop condition** — poll only while a deployment is in
   progress; stop when it reaches a terminal state.
4. **Graceful auth expiry** — any 401 flips the whole app back to sign-in.
5. **Clickjacking** — `frame-ancestors 'none'` so a page that can trigger
   deployments can't be framed by another site.
6. **Untrusted URLs in `href`** — only `http(s)` becomes a link
   (`javascript:` would execute).
7. **Design tokens** — colours named by meaning and mapped 1:1 to states.

#### Likely interview questions

**Why proxy /api through Next.js instead of calling the API from the browser?**
Calling `localhost:4000` from `localhost:3000` is cross-origin: CORS with
credentials, a cookie the browser may treat as third-party, and an Origin
allowlist to keep in sync. A rewrite makes it one origin. Trade-off: one extra
hop, and the dashboard's server must reach the API.

**Why client components instead of Server Components fetching data?**
Server-side fetching would have to forward the user's cookie from the
dashboard server to the API on every request. Client components call `/api`
directly with the browser's cookie, and polling naturally lives in the client.
Server Components become worth it when pages need SEO or first-paint data.

**Why polling, not WebSockets?**
A handful of users and short deploys: polling every 1.5 s only while something
changes is simple, stateless and survives API restarts. Live log streaming
(SSE) is a V3 item.

**How do you know which stage a FAILED deployment failed in?**
The API stores only the current status, so the UI infers it from artefacts: no
commit → the clone failed; commit but no container → detection or build;
container → start/health check. Exact per-stage events are a V3 item
(deployment events table).

**How did you test the UI?**
Pure logic (status model, formatting, API client) has unit tests. The pages
were driven in a headless browser against the real API and PostgreSQL with
seeded deployments in every state — which caught a layout bug where the stage
scale's water level was computed against a stretched container.

#### Trade-offs to be able to defend

| Decision                  | Alternative                   | Why this, for now                                 |
| ------------------------- | ----------------------------- | ------------------------------------------------- |
| Rewrite proxy             | CORS                          | One origin, zero cookie/CSRF special cases        |
| Hand-written API types    | Shared package / OpenAPI      | Small API; a shared package is the next step      |
| `useApi` (40 lines)       | TanStack Query / SWR          | Only load + poll needed; no cache invalidation yet |
| Polling                   | SSE / WebSockets              | Simple and stateless; SSE for logs in V3          |
| No component tests        | Testing Library / Playwright  | Logic is unit-tested; a Playwright suite is a V3 item |
