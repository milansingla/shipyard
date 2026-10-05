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
