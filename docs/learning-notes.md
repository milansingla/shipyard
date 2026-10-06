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

---

## Milestone 6 — Deploy on push (GitHub webhooks)

### Understand Before Interview

#### Key concepts

1. **HMAC signatures** — GitHub and Shipyard share a secret; GitHub sends
   `HMAC-SHA256(secret, body)`. Matching proves the sender knows the secret and
   the body wasn't changed.
2. **Raw body** — the HMAC covers exact bytes. Parsing and re-serialising JSON
   changes whitespace and key order, so verification must use the raw buffer.
3. **Constant-time comparison** — `timingSafeEqual` takes the same time however
   many bytes match, so an attacker can't guess the signature byte by byte.
4. **At-least-once delivery → idempotency** — webhooks are retried; the
   delivery id is a natural idempotency key. Insert first, act second.
5. **Coalescing** — many triggers while busy collapse into one follow-up run of
   the newest state (like a debounced build).
6. **The payload selects, the database decides** — the webhook only says
   *which* repository changed; what to clone comes from the stored project.

#### Likely interview questions

**How do you know a webhook really came from GitHub?**
Verify `X-Hub-Signature-256` with HMAC-SHA256 over the raw body and the shared
secret, in constant time, before reading anything else. Tested against GitHub's
own published example (`webhooks.test.ts`).

**What if GitHub delivers the same push twice?**
`webhook_deliveries` has the delivery id as primary key. The insert happens
before acting; a duplicate violates the key and returns "already handled". If
handling throws, the row is deleted so GitHub's retry isn't wrongly skipped.

**What happens if I push three times during a five-minute build?**
The first push finds the project busy and sets a flag; the next two find the
flag already set. When the build ends, the lock release sees the flag and
starts ONE deploy of the branch head — which contains all three commits.

**Why not deploy the exact commit SHA from the payload?**
Shallow clones fetch a branch, not an arbitrary SHA. Deploying the branch head
is what users expect anyway ("deploy the latest"), and with coalescing it is
always at least as new as the push. The deployment records the commit it built.

**Why return 200 before the deploy finishes?**
GitHub times out after ~10 s and retries; builds take minutes. Accept, record,
start in the background — same 202-style pattern as the API.

**Could an attacker with the secret run their own code?**
Only redeploy existing projects at their branch heads — the clone URL comes
from the project row, never the payload. Still, the secret should be rotated if
leaked; per-project secrets are a V3 item.

#### Trade-offs to be able to defend

| Decision                    | Alternative                      | Why this, for now                          |
| --------------------------- | -------------------------------- | ------------------------------------------ |
| One global webhook secret   | Per-project secrets              | One value to set; payload can't choose code |
| Repository webhooks         | GitHub App (org-wide)            | No app registration; GitHub App in V3      |
| In-memory "deploy again" flag | Persistent job queue           | Single process; push again after a restart |
| Branch head, not payload SHA | `git fetch <sha>`               | Shallow clone simplicity; coalescing-friendly |

---

## Milestone 7 — Traefik routing, zero-downtime redeploys

Code: [`services/routing/`](../apps/api/src/services/routing/), step 6 of
`DeploymentEngine.run`, `DeploymentService.stopDeployment` / `syncRoutes`,
`docker-compose.yml`. Overview: [routing.md](routing.md).

### Understand Before Interview

#### Key concepts

1. **Reverse proxy** — one entry point that forwards each request to a backend
   chosen by rules (here: the `Host` header). Apps stop needing their own ports.
2. **Host-based routing** — many apps share port 80; `shop.localhost` and
   `blog.localhost` differ only in the `Host` header the browser sends.
3. **Blue-green deployment** — run the new version next to the old one, switch
   traffic when the new one is ready, keep the old one for rollback. Shipyard's
   redeploys and rollbacks are exactly that.
4. **Confirming a cutover** — config reloads are asynchronous (Traefik applies
   at most one change every ~2s). "I wrote the file" ≠ "traffic moved".
   Shipyard asks Traefik until the `X-Shipyard-Deployment` header names the new
   deployment, and only then stops the old one.
5. **Atomic file replacement** — write a temp file, `rename()` it over the
   target: readers see the old file or the new one, never half of one. Also the
   only change Docker Desktop's file sharing reliably reports to Traefik.
6. **Derived state** — the route file is computed from the database and rebuilt
   at startup; it is never read back as truth.
7. **Graceful shutdown** — `docker stop` sends SIGTERM and waits 10s; an app that
   closes its server and finishes in-flight requests loses none of them.

#### Likely interview questions

**How does a redeploy avoid downtime?**
The old container keeps serving while the new one builds, starts and passes
its health check (directly, on a loopback port). Then the route is switched and
Shipyard waits until Traefik serves the hostname from the new container. Only
then is the deployment RUNNING and the old container stopped. The integration
test keeps four clients hitting the app through a real Traefik during a
redeploy and a rollback, and requires every response to be a 200.

**Why not use Traefik's Docker provider with labels? It's the usual setup.**
Two reasons. It needs the Docker socket, which is root on the host, in an
internet-facing process. And it starts routing to a container as soon as it
runs; Shipyard's rule is "no traffic before the health check passes". Writing
the route file ourselves keeps *when* in Shipyard's hands.

**What if Traefik never picks up the change?**
After 15s the deployment fails with `ROUTING_FAILED`, the previous route is
written back, and the new container stops. The old version never stopped
serving.

**Why can't Shipyard just sleep 2s after writing the file?**
The delay depends on Traefik's throttle, file-system events and load. It was
measured at 0.03s for one change and ~2s for the next. Polling for proof is
correct for any delay; a sleep is only right by luck.

**Why do containers still publish a port?**
For the health check. Shipyard runs on the host, and on macOS the host can't
reach container IPs, so a loopback-only published port is the portable way to
check a container before it gets traffic.

**How is rollback zero-downtime?**
Restarting an older STOPPED deployment runs the same cutover: health check,
switch the route, confirm, then retire the current deployment.

#### Trade-offs to be able to defend

| Decision                         | Alternative                    | Why this, for now                                  |
| -------------------------------- | ------------------------------ | -------------------------------------------------- |
| File provider, one file          | Docker labels                  | No socket access; Shipyard decides when traffic moves |
| One file, rewritten each change  | One file per project           | Deleting files isn't reliably seen through Docker Desktop; one table is simpler to reason about |
| Probe via response header        | Traefik's API                  | No extra Traefik entry point to expose and secure  |
| `*.localhost`, HTTP, loopback    | Real domains + Let's Encrypt   | Zero DNS setup locally; HTTPS is V3                |
| Opt-in (`SHIPYARD_PUBLIC_DOMAIN`) | Always on                      | CLI and setups without Traefik keep working        |
| Shared `shipyard-edge` network   | Network per project            | Simple; isolation between apps is a later item     |


---

# V3 — Production deployment platform

## V3.1 — A richer state machine

**Key idea.** Every status names work that is actually happening, and is
persisted when it starts: QUEUED → CLONING → DETECTING → BUILDING → STARTING →
HEALTH_CHECKING → HEALTHY → ROUTING → RUNNING. `failedStage` records where a
FAILED deployment stopped, so nobody has to infer it from leftovers.

**Interview: renaming an enum value in production PostgreSQL?**
`ALTER TYPE … RENAME VALUE` keeps every existing row valid. Prisma's generated
migration would create a new type and cast the column, which fails for rows
holding the old value. So the migration is hand-written, and
`prisma migrate diff` proves schema and migrations still agree.

## V3.2 — Environment variables & secrets

**Key ideas.**
1. **Encrypt everything at rest**, not only "secrets": users mis-label things.
   The `secret` flag decides *visibility*, not *protection*.
2. **Authenticated associated data (AAD)**: AES-GCM can authenticate extra
   context that isn't stored. Binding `env:<projectId>:<key>` means a
   ciphertext moved to another row fails to decrypt instead of leaking.
3. **Build args are not secret**: Docker writes them into image history.
   Runtime env lives in the container config, not in image layers.
4. **Immutable deployments**: a container keeps the environment it started
   with; changes apply on the next deploy, and rollback restores old config too.

**Interview: why not store secrets in plaintext and rely on DB access control?**
Backups, replicas, logs of slow queries and support dumps all copy the
database. Encryption with a key that lives elsewhere (`SHIPYARD_SECRET_KEY`)
means a leaked dump alone reveals nothing.

**Interview: what if the encryption key is lost or rotated?**
Values can't be decrypted. Shipyard fails the deploy before it starts, naming
the variable to re-enter, rather than deploying with missing config.
Supporting rotation properly means versioned keys (the `v1:` prefix leaves
room for it).

| Decision | Alternative | Why this, for now |
| -------- | ----------- | ----------------- |
| App-level AES-GCM | pgcrypto / KMS / Vault | No extra service; key outside the DB; V6 adds secret providers |
| Secrets runtime-only | BuildKit `--mount=type=secret` | Simple and safe; build secrets later |
| Changes on next deploy | Live-update containers | Containers are immutable; exact rollbacks |

## V3.3 — Health checks and resource limits, per project

**Key ideas.**
1. **Startup gate, not monitoring.** The health check decides once whether a
   new version may take traffic. Continuous liveness checks are a later item.
2. **Immutable deployment settings.** Health settings are stored on the
   container as labels; a rollback is checked exactly as it was originally.
3. **cgroups** enforce limits: `NanoCpus` throttles CPU time, `Memory` makes
   the kernel OOM-kill the process. `MemorySwap = Memory` disables swap, so the
   limit is real rather than a slow-down.
4. **Docker state is subtle**: under a restart policy, `Running: true` and
   `Restarting: true` together mean "crash-looping", not "up".

**Interview: why doesn't a custom health path accept a 404?**
On `/`, a 404 proves the server listens (many APIs have no root route). On a
path the user chose, a 404 means the path is wrong, and accepting it would let
a broken deployment take traffic.

**Interview: what stops a health path from probing another host?**
Validation (single leading `/`, no `//`, control characters or `\`) plus a
second check in the engine: the URL is resolved against
`http://127.0.0.1:<port>` and must keep that origin.

| Decision | Alternative | Why this, for now |
| -------- | ----------- | ----------------- |
| Timeout only, no "retries" | Interval × retries (Kubernetes probes) | One number; checks run every second |
| Limits off by default | Default 512 MB | A wrong default breaks apps confusingly; opt-in and visible |
| `UNLESS_STOPPED` by default | `NO` | Production apps should survive crashes and host reboots |

---

# V4 — Developer platform

## API keys, audit log, teams, CLI

- **Hash, don't encrypt, tokens you only need to check**: an API key is
  stored as sha256; like a session token, it can be verified but never shown
  again. A recognisable prefix (`shp_`) lets secret scanners catch leaks.
- **Authorization in one place**: `AccessService` turns "user, project,
  needed role" into allow / 403 / 404. Services never write their own
  ownership queries any more, so a missing check is visible in review.
- **404 vs 403**: non-members get 404, so they can't learn which ids exist;
  members with too low a role get 403, because telling them why helps.
- **Data migrations by hand**: moving projects into organizations needed
  INSERT … SELECT and UPDATE … FROM steps Prisma can't generate. They were run
  against rows that already existed before committing.
- **Thin clients**: the CLI is HTTP calls plus formatting. Deployment logic
  stays on the server, so the CLI, dashboard and API can't disagree.

## Build cache

**Interview: why copy package.json before the source?** Each Dockerfile step
is a cached layer keyed by its inputs. Copying everything first makes any
code change invalidate the dependency install. Copying the manifests first
makes the install depend only on them. The exceptions (install hooks,
workspaces) are where the install really reads other files, so caching
there would be wrong.


## Persistent volumes

- **Containers are disposable, data isn't**: every deploy replaces the
  container and everything written inside it. A named volume is storage
  Docker keeps outside any container, mounted into each new one.
- **Name things by identity, not by label**: a volume named after the
  project slug would be found again by a *new* project that reuses the slug.
  Using the service's UUID makes leftover data unreachable by anyone else.
- **Destructive actions must be explicit**: detaching keeps data; deleting a
  service with volumes is refused unless the request says `deleteData=true`;
  the foreign key is `Restrict` so no cascade can drop data quietly.
- **Ownership of a fresh volume**: Docker creates it as root. A one-off
  container runs `chown` as root for the image's user, so apps running as
  `node` can write, without running the app itself as root.

**Interview: why not bind-mount a host directory?** A bind mount exposes a
host path to a container that runs untrusted code, and its ownership and
existence depend on the host. A named volume is managed by Docker, created
on demand and labelled, so Shipyard can find and remove only its own.

## PostgreSQL services

- **Zero downtime isn't always right**: for stateless apps, start the new
  version before stopping the old. For a database, two servers on one data
  directory can corrupt it, so the order flips: stop, start, and restart the
  old one if the new one fails. The strategy belongs to the kind of service.
- **Readiness from inside**: on macOS, Docker's port proxy accepts TCP
  connections even before the app listens, so "the port is open" proves
  nothing from the host. `pg_isready` run by Docker inside the container,
  against 127.0.0.1, answers the real question.
- **Secrets as plain configuration**: the generated password and URL are
  ordinary encrypted variables, so they show up where every other setting
  does, and nothing new had to be built to store or inject them.
- **Self-hosted ≠ managed**: a container with a volume gives you a database,
  not backups, failover, upgrades or monitoring. Say so where people decide.

**Interview: why not let `docker pull` run on every deploy?** A tag like
`postgres:17-alpine` moves when a new image is published. Pulling only when
missing means every deploy of a service runs the same image; upgrading is a
deliberate act, not a surprise during a restart.

## Replicas and rolling deployments

- **Find containers by label, not by bookkeeping**: replicas carry the
  deployment id as a Docker label, so stop/restart/delete ask Docker for
  "every container of deployment X" instead of keeping a second list that
  could drift from reality.
- **Roll out one at a time**: starting and checking replicas one by one means
  a bad version fails at its first replica, before the rest are started.
- **Active health checks need a meaningful endpoint**: a load balancer
  removing "unhealthy" backends is only as good as the check. Checking `/` on
  apps that answer 404 there would take every replica out.

**Interview: what does "drain" mean here?** The route moves to the new
replicas first (and is confirmed), so no new requests reach the old ones;
then `docker stop` sends SIGTERM and waits 10s, letting requests already in
flight finish before the process exits.

## Cron jobs

- **The database as the lock**: "claim this occurrence" is one conditional
  UPDATE (`WHERE nextRunAt = <what I read>`). If two schedulers race, one
  updates a row and the other updates none: no separate lock service needed.
- **Catch up once**: computing the next occurrence from *now* rather than from
  the missed one turns a backlog after downtime into a single run instead of
  a burst.
- **Never overlap**: a job that runs longer than its interval is skipped, not
  stacked; overlapping cleanups are a classic source of deadlocks.
- **Reuse the deployed image**: a job runs exactly the code that is live,
  with the same variables and network, so "works in the app, fails in cron"
  can't come from a different build.

**Interview: why 5-field cron in UTC only?** Time zones bring daylight-saving
gaps (a 02:30 job that doesn't exist one night, or runs twice another).
UTC has neither; converting a local time is the user's explicit choice.

## Environments

- **Make the common case implicit**: production is "no environment" (null),
  so every existing deployment stayed valid without a data migration, and
  every query about the live app says `environmentId: null` explicitly.
- **Least privilege for untrusted code**: a preview runs a pull request's
  code, so it gets no production secrets unless one is deliberately set for
  previews. The safe default is the one that needs no remembering.
- **Bind ciphertexts to their context**: the environment is part of what a
  secret is encrypted against, so moving a production value into a preview
  row (a bug, or a malicious write) fails to decrypt instead of leaking.

## Pull request previews

- **Who wrote the code decides whether it runs**: a branch in the repository
  was pushed by someone with write access; a fork's pull request was not.
  Previews build only the former, without needing a maintainer to approve.
- **Event-driven lifecycle**: GitHub tells Shipyard when a pull request opens,
  changes and closes, so previews appear and disappear without polling; the
  same signature check and delivery dedupe as pushes protect it.
