# Deployment engine

Code: [`apps/api/src/services/deployment/DeploymentService.ts`](../apps/api/src/services/deployment/DeploymentService.ts)

## Pipeline

```
validate input ──✗──► ValidationError (no deployment is created)
      │
  PENDING
      │
  CLONING ─── git clone --depth 1 --single-branch [--branch B] -- <url> <workspace>/<id>
      │       git rev-parse HEAD  → commitSha
      │       prepareBuild():
      │         repo has a Dockerfile  → use it; port from last EXPOSE, else 3000
      │         else package.json      → generate .shipyard.Dockerfile; port 3000
      │         else                   → DOCKERFILE_NOT_FOUND
  BUILDING ── docker build (tar of the clone; .dockerignore applied, .git excluded)
      │       workspace deleted (source now lives in the image)
  STARTING ── docker create + start, PORT=<port>, published on 127.0.0.1:<random>
      │       health check loop
  HEALTHY ─── app answered HTTP < 500
      │       routing registered (today: host port URL; later: Traefik)
  RUNNING

any step fails ──► FAILED  (errorMessage stored, runtime logs captured,
                            container stopped but kept for inspection)
```

## Status model

| Status     | Meaning                                         | Next                         |
| ---------- | ----------------------------------------------- | ---------------------------- |
| `PENDING`  | Created, not started                            | CLONING, FAILED              |
| `CLONING`  | Fetching source                                 | BUILDING, FAILED             |
| `BUILDING` | `docker build` running                          | STARTING, FAILED             |
| `STARTING` | Container started, waiting for health           | HEALTHY, FAILED              |
| `HEALTHY`  | App responds over HTTP                          | RUNNING, STOPPING, FAILED    |
| `RUNNING`  | Healthy **and** reachable at its URL            | STOPPING, STARTING, FAILED   |
| `STOPPING` | Stop requested                                  | STOPPED, FAILED              |
| `STOPPED`  | Container stopped                               | STARTING (restart)           |
| `FAILED`   | Terminal. Fix and redeploy (= new deployment)   | —                            |

### Why HEALTHY and RUNNING are separate
HEALTHY says *the process works*. RUNNING says *users can reach it*. With
Traefik (M7) there's real work between them — registering the route — and a
redeploy will only switch traffic once the new version is HEALTHY.

## Health checks

`container.start()` succeeding only means Docker launched a process. The app may
still be booting, crash a second later, or listen on the wrong port/interface.

Rule: poll `http://127.0.0.1:<hostPort>/` every 1s, up to
`SHIPYARD_HEALTHCHECK_TIMEOUT_MS` (default 60s).

- Any status **< 500** → healthy (a 404 still proves the server listens).
- 5xx, connection refused, timeout → retry.
- Container no longer running → fail immediately with its exit code.

Planned: configurable health path per project (M2/M3).

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

| Source    | What                               | Where today                              |
| --------- | ---------------------------------- | ---------------------------------------- |
| `build`   | `docker build` output              | streamed to the observer (CLI prints it) |
| `runtime` | app stdout/stderr                  | Docker's log driver, read on demand      |
| `system`  | Shipyard's own progress messages   | observer                                 |

Runtime logs are read from Docker (`docker logs` equivalent) and demultiplexed.
Persisting build logs is part of M2 — they will be stored outside PostgreSQL
rows or capped, not appended forever to the database.

## Restart & stop

Without a database (M1), the current status is derived from Docker state.
Restart = `docker restart` → re-read the host port (Docker may assign a new
ephemeral one) → health check. Stop is idempotent.

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

Cleaning up everything Shipyard created:

```bash
docker rm -f $(docker ps -aq --filter label=shipyard.managed=true)
docker rmi $(docker images -q --filter label=shipyard.managed=true)
```
