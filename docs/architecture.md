# Architecture

## V5: a control plane and workers

```
 Browser ─► apps/web ─┐            CLI / CI (API keys, /api/v1) ─┐
                      ▼                                          ▼
 ┌──────────────── control plane: apps/api (server.ts) ───────────────────────────┐
 │ HTTP: originCheck → authenticate (session | API key) → key scopes → rate limits │
 │ modules/  projects · services · environments · cron · domains · env variables   │
 │           access (orgs, teams, service accounts) · policies · audit · alerts    │
 │           metrics · ai (advisory, read-only tools)                              │
 │                                                                                 │
 │ DeploymentService ── deploy_jobs queue (PostgreSQL, FOR UPDATE SKIP LOCKED)     │
 │   claim → scheduler.pickWorker → lease (60 s, renewed) → engine for that worker │
 │   lost lease → WORKER_LOST, retried only if no container had started            │
 │                                                                                 │
 │ engine for a worker:  built-in → DeploymentEngine + Docker on this host         │
 │                       remote   → RemoteEngine ─► WorkerCalls (long-poll RPC) ───┼──┐
 │ background loops: queue pump · lease renewal · worker heartbeats/offline ·      │  │
 │   metrics sampling (30 s) · alert evaluation · cron · hourly cleanup            │  │
 └──────┬───────────────────────────────┬──────────────────────────┬───────────────┘  │
        │ Prisma                        │ Docker API               │ routes file      │ HTTPS, worker secret
        ▼                               ▼                          ▼                  ▼
   PostgreSQL                  built-in worker's containers   Traefik ──► apps   remote worker (src/worker/agent.ts):
   (state, queue, metrics,                                    (local or at a     its own Docker + DeploymentEngine;
    audit, alerts)                                            worker's address)  publishes ports for Traefik
```

- **One source of truth.** Every decision (who may do what, which worker,
  what is live) is made by the control plane against PostgreSQL. Workers only
  run what they are told and report back; they hold no database credentials.
- **The queue is a table.** `deploy_jobs` with a partial unique index (one
  RUNNING job per project/environment) gives FIFO per project, priorities
  (manual before push), and survives restarts. No Redis.
- **Workers are pull-based.** They long-poll for calls, so they need no
  inbound ports from the control plane, only for app traffic from Traefik.
- **Periodic work is in-process** with `unref`'d timers, each idempotent and
  safe to run on a restarted process (see [operations.md](operations.md)).
- **AI is a client, not an actor.** It reads through the same `AccessService`
  as the API and returns proposals; see [ai.md](ai.md).

Details: [workers.md](workers.md), [observability.md](observability.md),
[operations.md](operations.md), [rbac.md](rbac.md), [environments.md](environments.md).

## V3 shape (single host)

```
 Browser ──► apps/web (Next.js, :3000) ── pages + rewrite /api/* ──┐
                                                                    │ same-origin proxy
 CLI / curl ────────────────────────────────────────────────────────┤
                                                                    ▼
            ┌──────────── apps/api ──────────────────────────────────────────────┐
 CLI ──────►│ cli.ts ─────────┐                                                  │
            │                 ├─► bootstrap.ts (composition root)                │
 HTTP ─────►│ server.ts ─► app.ts ─► originCheck ─► authenticate (session cookie) │
            │              routes: health, auth, github, projects, deployments   │
            │  modules/  AuthService ── GitHub OAuth, sessions ─► GitHubClient   │
            │  modules/  ProjectService ─┐                                       │
            │            DeploymentService ── persists status, 1 deploy/project, │
            │              │   │              retires old deployment, reconciles │
            │              │   └─ BuildLogStore     build logs as files          │
            │              ▼                                                     │
            │  services/ DeploymentEngine ── step order for ONE run             │
            │              ├─ GitService          clone (git CLI, hardened)      │
            │              ├─ prepareBuild        own Dockerfile or generate one │
            │              ├─ DockerService       build / run / logs (Dockerode) │
            │              ├─ HealthCheckService  HTTP probe                     │
            │              ├─ WorkspaceService    temp clone dirs                │
            │              └─ Router              TraefikRouter: routes.yml +    │
            │                                     cutover check (or plain ports) │
            └────────────┬──────────────────────────────────┬──────────┬─────────┘
                         │ Prisma (pg adapter)              │ Docker   │ writes routes.yml
                         ▼                                  ▼ API      ▼
                    PostgreSQL                        Docker daemon   Traefik (:80, no Docker socket)
                                                           │             │ <slug>.localhost
                                                           └──► app containers ◄┘ (network shipyard-edge)
```

## Responsibilities

| Component            | Knows about                         | Does NOT know about        |
| -------------------- | ----------------------------------- | -------------------------- |
| `AuthService`        | OAuth flow, sessions, allowlist     | projects, Docker           |
| `WebhookService`     | signed GitHub deliveries, idempotency, which projects a push deploys | Docker, sessions |
| `GitHubClient`       | GitHub HTTP API, response validation | database, sessions        |
| `DeploymentService`  | database, ownership, project lock, retiring old deployments | git flags, Docker API |
| `DeploymentEngine`   | step order, statuses, failure policy for one run | database, other deployments |
| `prepareBuild` + `detection/` | Dockerfile vs Node.js detection, generation | Docker API, database |
| `GitService`         | `git` CLI, hardening flags          | deployments, Docker        |
| `DockerService`      | images, containers, labels, logs    | deployments, statuses      |
| `HealthCheckService` | HTTP probing, timeouts              | Docker internals           |
| `TraefikRouter`      | route table file, confirming a cutover through Traefik | database, Docker API |
| `EnvironmentService` | encrypted per-project variables, decrypting them for a deploy | Docker, routing |
| `DomainService`      | custom hostnames, refreshing the live route | Docker, certificates |
| `rateLimit`          | per-IP / per-user request budgets | what the routes do |
| `sse.ts`             | Server-Sent Events framing, keep-alive, max age | logs, deployments |
| `WorkspaceService`   | safe temp directories               | git, Docker                |

**Why split `DeploymentEngine` and `DockerService`?** The deployment is a
*business process* (statuses, rules like "don't mark RUNNING before healthy");
Docker is an *infrastructure detail*. Keeping them apart means the process can
be tested with a fake Docker, and Docker code never needs to change when the
process does (e.g. adding Traefik routing or a database).

## Key design decisions

### Dependency injection via a composition root
All concrete objects are created in [`bootstrap.ts`](../apps/api/src/bootstrap.ts).
Services receive dependencies through their constructor and depend on the
narrowest type they need (`Pick<DockerService, "buildImage" | …>`). No
singletons, no hidden global state. Config is loaded once at the entrypoint.

### Explicit status machine
[`status.ts`](../apps/api/src/services/deployment/status.ts) lists every legal
transition. Illegal moves throw. See [deployment-engine.md](deployment-engine.md).

### Errors
- `AppError` = expected failure with a stable `code` and HTTP `statusCode`.
- Anything else reaching the HTTP layer is a bug → logged with stack, returned as a generic 500 in production.
- API shape: success `{ "data": … }`, failure `{ "error": { "code", "message", "details?" } }`.

### Configuration
[`config/env.ts`](../apps/api/src/config/env.ts) validates all environment
variables with Zod at startup. Invalid config = process refuses to start with a
readable message. See [.env.example](../.env.example) for every variable.

### Logging
pino, structured JSON. Pretty-printed in development. Each deployment's logs
carry a `deploymentId` field. Authorization headers/cookies/tokens are redacted.

### Module system
ESM + TypeScript `NodeNext` resolution — imports use explicit `.js` extensions
because that's what Node resolves at runtime after compilation.

## Persistence
PostgreSQL via Prisma holds projects and deployment history; build logs are
files. Docker labels (`shipyard.managed`, `shipyard.deployment-id`,
`shipyard.project-id`, `shipyard.container-port`) remain the link from a
container back to its records, and the guard that stops Shipyard touching
containers it didn't create. Details: [database.md](database.md).

## Technologies deliberately NOT used (yet)

| Not using     | Because                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| Redis / message broker | The deploy queue is a PostgreSQL table (`SKIP LOCKED` claims, leases); worker calls are an in-memory long poll. One fewer system to run and back up. |
| WebSockets    | Polling is enough for logs/status in a dashboard at this scale.          |
| Kubernetes    | Docker on each worker + Traefik covers scheduling, routing and isolation at this scale. |
| Traefik's Docker provider | It needs the Docker socket (root) and routes before Shipyard's health check. Shipyard writes the routes itself — [routing.md](routing.md). |
| Microservices | One deployable is easier to understand, debug and run.                  |

## Evolution of V0.1

| V0.1 (JavaScript)                         | V2 M1 (TypeScript)                                   |
| ----------------------------------------- | ---------------------------------------------------- |
| `Date.now()` deployment ids               | `crypto.randomUUID()`                                 |
| Build errors ignored → "success"          | `errorDetail` events detected → `DOCKER_BUILD_FAILED` |
| `logs().toString()` showed binary headers | Docker stream demultiplexed                           |
| "started" = success                       | HTTP health check, then RUNNING                       |
| Ports published on 0.0.0.0                | 127.0.0.1 by default                                  |
| stop/restart any container by name        | Only containers labelled `shipyard.managed=true`      |
| Clones left in `tmp/` forever             | Clone deleted right after build                       |
| Any URL passed to `git clone`             | HTTPS allowlist + hardened git flags                  |
| Services constructed their own deps       | Injected via composition root                         |
