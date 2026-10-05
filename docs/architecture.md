# Architecture

## Current shape (V2 · Milestone 7)

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
| Redis / queue | One process, handful of deploys. Revisit if deploys must survive restarts or run on several workers. |
| WebSockets    | Polling is enough for logs/status in a dashboard at this scale.          |
| Kubernetes    | Single host. Docker + Traefik covers routing and isolation needs for V2. |
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
