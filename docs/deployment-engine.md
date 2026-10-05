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
      │       detectDockerfile()  → port from last EXPOSE, else 3000
  BUILDING ── docker build (tar of the clone minus .git), labels applied
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

## Port detection

1. Last `EXPOSE <n>` (or `<n>/tcp`) in the Dockerfile.
2. Otherwise `3000`.

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
| `DOCKERFILE_NOT_FOUND`                    | No `Dockerfile` at repo root (generation comes in M3)  |
| `DOCKER_BUILD_FAILED`                     | A step in the Dockerfile failed — read the build log   |
| `exited with code N before becoming healthy` | App crashed on boot — check runtime logs            |
| health check times out with `ECONNREFUSED` | App listens on `localhost` or a different port       |

Cleaning up everything Shipyard created:

```bash
docker rm -f $(docker ps -aq --filter label=shipyard.managed=true)
docker rmi $(docker images -q --filter label=shipyard.managed=true)
```
