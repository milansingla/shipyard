# Deployment engine

Code: [`services/deployment/DeploymentEngine.ts`](../apps/api/src/services/deployment/DeploymentEngine.ts)
(mechanics of one run) and
[`modules/deployments/DeploymentService.ts`](../apps/api/src/modules/deployments/DeploymentService.ts)
(persistence, one-at-a-time per project, retiring the previous deployment).
Routing and zero-downtime switching: [routing.md](routing.md).

## Pipeline

```
validate input ──✗──► ValidationError (no deployment is created)
      │
  QUEUED
      │
  CLONING ─────────── git clone --depth 1 --single-branch [--branch B] -- <url> <workspace>/<id>
      │               git rev-parse HEAD  → commitSha
  DETECTING ───────── prepareBuild():
      │                 repo has a Dockerfile  → use it; port from last EXPOSE, else 3000
      │                 else package.json      → generate .shipyard.Dockerfile; port 3000
      │                 else                   → DOCKERFILE_NOT_FOUND
  BUILDING ────────── docker build (tar of the clone; .dockerignore applied, .git excluded)
      │               workspace deleted (source now lives in the image)
  STARTING ────────── docker create + start, PORT=<port>, published on 127.0.0.1:<random>
      │               (with routing: attached to the shipyard-edge network)
  HEALTH_CHECKING ─── poll the app until it answers HTTP < 500
      │
  HEALTHY ─────────── the app works; the previous deployment is still serving
      │
  ROUTING ─────────── route: <slug>.<domain> → this container, confirmed through Traefik
      │               (without routing: URL = http://localhost:<published port>)
  RUNNING ─────────── DeploymentService then retires the previous deployment

any step fails ──► FAILED  (errorMessage + failedStage stored, runtime logs
                            captured, container stopped but kept for inspection)
```

## Status model

| Status            | Meaning                                              | Next                         |
| ----------------- | ---------------------------------------------------- | ---------------------------- |
| `QUEUED`          | Created, not started                                 | CLONING, FAILED              |
| `CLONING`         | Fetching source                                      | DETECTING, FAILED            |
| `DETECTING`       | Choosing the repo's Dockerfile or generating one     | BUILDING, FAILED             |
| `BUILDING`        | `docker build` running                               | STARTING, FAILED             |
| `STARTING`        | Container being created and started                  | HEALTH_CHECKING, FAILED      |
| `HEALTH_CHECKING` | Waiting for the app to answer HTTP                   | HEALTHY, FAILED              |
| `HEALTHY`         | App responds over HTTP; no traffic yet               | ROUTING, STOPPING, FAILED    |
| `ROUTING`         | Moving the project's address to it                   | RUNNING, FAILED              |
| `RUNNING`         | Healthy **and** serving the project's address        | STOPPING, STARTING, FAILED   |
| `STOPPING`        | Stop requested                                       | STOPPED, FAILED              |
| `STOPPED`         | Container stopped                                    | STARTING (restart)           |
| `FAILED`          | Terminal. `failedStage` says where. Redeploy to fix  | —                            |

Restart (and rollback) walk the same tail: `STARTING → HEALTH_CHECKING →
HEALTHY → ROUTING → RUNNING`. Every move is checked against
[`status.ts`](../apps/api/src/services/deployment/status.ts) and persisted as it
happens, so the dashboard shows the real stage, not a guess.

**Why HEALTHY comes before ROUTING.** The V3 plan lists ROUTING before HEALTHY
("register route, then mark healthy"). Shipyard has one route per project, so
registering the route *is* switching traffic. Marking HEALTHY first keeps the
rule "a deployment becomes HEALTHY only after its health check" literal, and
ROUTING then means exactly one thing: traffic is moving to it.

### Why HEALTHY and RUNNING are separate
HEALTHY says *the process works*. RUNNING says *users can reach it*. With
routing on, the ROUTING stage between them is real work: Shipyard points the
project's hostname at the new container and waits until Traefik actually
serves it from there. A deployment that fails that step (`ROUTING_FAILED`) never took traffic,
and the previous one keeps serving. See [routing.md](routing.md#the-cutover-redeploy).

## Health checks

`container.start()` succeeding only means Docker launched a process. The app may
still be booting, crash a second later, or listen on the wrong port/interface.

Rule: poll `http://127.0.0.1:<published port><path>` every 1s until it
passes or the timeout ends.

- On the default path `/`: any status **< 500** → healthy (a 404 still proves
  the server listens; many APIs have no route at `/`).
- On any other path: only **2xx/3xx** → healthy. A 404 there means the path is
  wrong, and the error says so.
- 5xx, connection refused, timeout → retry.
- Container no longer running → fail immediately with its exit code.

### Per-project settings

Project page → **Settings**, or `PATCH /api/projects/:id`:

| Setting | Default | Rules |
| ------- | ------- | ----- |
| `healthCheckPath` | `/` | A path, never a URL: one leading `/`, no `//`, spaces, control characters, `\` or `#`. Query strings are fine. |
| `healthCheckPort` | the app's port | 1–65535. If different from the app's port, it is published too, on **127.0.0.1 only** (it is for Shipyard, not visitors). |
| `healthCheckTimeoutSeconds` | `SHIPYARD_HEALTHCHECK_TIMEOUT_MS` (60s) | 5–900 |

`null` resets a setting to its default. Settings apply to the next
deployment, and each container records the settings it was created with in
its labels (`shipyard.health-*`). A restart or rollback therefore checks a
deployment exactly as it was checked when it went live, even if the project's
settings have changed since.

**Why there is no "retries" setting.** Checks run every second until the
timeout ends, so "retries" would only restate the timeout (60s ≈ 60 tries).
One number is easier to reason about. The check is only for *startup*:
Shipyard decides once whether a new version may take traffic. Continuous
monitoring of running apps is a later item.

The engine resolves the path against `http://127.0.0.1:<port>` and verifies
the origin didn't change, so even a path that slipped past validation could
only ever change the path, never the host being probed.

## Build detection & Dockerfile generation

Code: [`services/build/prepareBuild.ts`](../apps/api/src/services/build/prepareBuild.ts),
[`services/detection/`](../apps/api/src/services/detection/)

The repository's own `Dockerfile` always wins — the user stays in control.
Without one, a `package.json` at the root makes it a Node.js project and
Shipyard generates `.shipyard.Dockerfile` (a reserved name, so it can never
overwrite a repository file). Anything else fails with `DOCKERFILE_NOT_FOUND`.

| Decision         | Rule                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Package manager  | `packageManager` field (corepack) → else lockfile: `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json` → else npm |
| Install          | `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` (`--immutable` for Yarn 2+); plain install without a lockfile |
| Node version     | newest of 24, 22, 20 satisfying `engines.node`; default 24; unsatisfiable → error          |
| Build            | `<pm> run build` if a `build` script exists                                                |
| Start            | `start` script → `<pm> start`; else `node <main>`; else `server.js` / `index.js` / `app.js` |
| Port             | 3000, passed as `PORT`                                                                    |

Every decision that might surprise (no lockfile, several lockfiles, Node 20)
is written to the build log as a `note:`, followed by the full generated
Dockerfile. Example for a pnpm app with a build step:

```dockerfile
FROM node:24-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm","start"]
```

If the repository has no `.dockerignore`, a default one (`node_modules`, `.git`)
is added so a committed `node_modules` with host binaries is never copied in.

**Not supported by generation** (add a Dockerfile instead): monorepo
sub-directories, static sites without a server, non-Node languages, Node
versions other than 20/22/24. Generation is deliberately conservative: when it
can't be sure, it fails with `PROJECT_DETECTION_FAILED` and says why, rather
than guessing and producing an image that fails at runtime.

## Port detection

1. Repository Dockerfile: last `EXPOSE <n>` (or `<n>/tcp`), otherwise `3000`.
2. Generated Dockerfile: always `3000`.

Shipyard passes the port to the app as `PORT`. Apps must bind `0.0.0.0` — a
server bound to `localhost` inside a container is unreachable from outside it.

## Logs

| Source    | What                               | Stored                                                  |
| --------- | ---------------------------------- | ------------------------------------------------------- |
| `build`   | `docker build` output              | build log file `<SHIPYARD_DATA_DIR>/logs/<id>.log`      |
| `system`  | Shipyard's own progress messages   | same build log file                                     |
| `runtime` | app stdout/stderr                  | Docker's json-file driver (3 × 10 MB), read on demand; a failed start's last 50 lines are copied into the build log, prefixed `[app]` |

`GET /api/deployments/:id/logs?type=build` returns the build log;
`?type=runtime&tail=200` reads the container's output. Build logs stop growing
at 20 MB and are trimmed to their last 2 MB when the build ends (the error is
at the end). See [database.md](database.md#decisions) for why logs are files.

## Restart & stop

Restart = `docker restart` → re-read the host port (Docker may assign a new
ephemeral one) → health check → route → RUNNING. It responds only after the
health check, unlike deploy (202, background). Stop takes the deployment out
of the router, then stops the container; it is idempotent.

Only one deploy/restart per project runs at a time (409 `DEPLOYMENT_IN_PROGRESS`).
A new deployment retires the previous one only **after** it is RUNNING, so a
failed deploy leaves the old version serving. Retired containers are stopped,
not removed: restarting an older STOPPED deployment brings it back and retires
the current one — the V2 rollback mechanism. With routing on, both redeploys
and rollbacks switch traffic without downtime; restarting the *live*
deployment does not (it is the same container).

## Debugging

Follow the layers, in order:

```bash
docker version                                   # 1. Is Docker running?
docker ps -a --filter label=shipyard.managed=true # 2. Did the container get created? Status/exit code?
npm run shipyard -- logs <container>              # 3. What did the app print?
docker inspect <container> --format '{{json .State}}'
docker inspect <container> --format '{{json .NetworkSettings.Ports}}'
docker images 'shipyard/*'                        # 4. Was the image built?
curl -v http://127.0.0.1:<hostPort>/              # 5. Does the app answer?
LOG_LEVEL=debug npm run shipyard -- deploy <url>  # 6. Verbose engine logs
```

| Symptom                                   | Likely cause                                           |
| ----------------------------------------- | ------------------------------------------------------ |
| `DOCKER_UNAVAILABLE` / `connect ENOENT`   | Docker Desktop not running                             |
| `GIT_CLONE_FAILED … could not read Username` | Private or non-existent repo (private repos need M4)  |
| `DOCKERFILE_NOT_FOUND`                    | Neither a `Dockerfile` nor a `package.json` at repo root |
| `PROJECT_DETECTION_FAILED`                | Node project Shipyard can't build safely — message says why (no start script, unsupported Node, …) |
| `DOCKER_BUILD_FAILED`                     | A step in the Dockerfile failed — read the build log   |
| `exited with code N before becoming healthy` | App crashed on boot — check runtime logs            |
| health check times out with `ECONNREFUSED` | App listens on `localhost` or a different port       |
| `ROUTING_FAILED`                          | Traefik not running or reading another directory — [routing.md](routing.md#debugging) |

Cleaning up everything Shipyard created:

```bash
docker rm -f $(docker ps -aq --filter label=shipyard.managed=true)
docker rmi $(docker images -q --filter label=shipyard.managed=true)
```
