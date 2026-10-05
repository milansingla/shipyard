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
