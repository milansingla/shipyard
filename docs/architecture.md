# Architecture

## Current shape (V2 · Milestone 1)

```
            ┌──────────── apps/api ─────────────────────────────────────────┐
 CLI ──────►│ cli.ts ─┐                                                     │
            │         ├─► bootstrap.ts (composition root)                   │
 HTTP ─────►│ server.ts ─► app.ts ─► routes/health                          │
            │                                                               │
            │   DeploymentService  ── owns statuses & step order            │
            │     ├─ GitService          clone (git CLI, hardened)          │
            │     ├─ detectDockerfile    inspect source                     │
            │     ├─ DockerService       build / run / logs (Dockerode)     │
            │     ├─ HealthCheckService  HTTP probe                         │
            │     └─ WorkspaceService    temp clone dirs                    │
            └──────────────────────────────┬────────────────────────────────┘
                                           │ Docker Engine API (unix socket)
                                           ▼
                                     Docker daemon ──► app containers
```

## Responsibilities

| Component            | Knows about                         | Does NOT know about        |
| -------------------- | ----------------------------------- | -------------------------- |
| `DeploymentService`  | step order, statuses, failure policy | git flags, Docker API      |
| `GitService`         | `git` CLI, hardening flags          | deployments, Docker        |
| `DockerService`      | images, containers, labels, logs    | deployments, statuses      |
| `HealthCheckService` | HTTP probing, timeouts              | Docker internals           |
| `WorkspaceService`   | safe temp directories               | git, Docker                |
| `detection/`         | reading a source tree               | anything with side effects |

**Why split `DeploymentService` and `DockerService`?** The deployment is a
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

## Why no database yet?
Milestone 1 is a behaviour-preserving port. Until PostgreSQL arrives (M2),
Docker labels (`shipyard.managed`, `shipyard.deployment-id`,
`shipyard.container-port`) carry the minimum metadata needed for
logs/stop/restart. `DeploymentRecord` already mirrors the planned Prisma model.

## Technologies deliberately NOT used (yet)

| Not using     | Because                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| Redis / queue | One process, handful of deploys. Revisit if deploys must survive restarts or run on several workers. |
| WebSockets    | Polling is enough for logs/status in a dashboard at this scale.          |
| Kubernetes    | Single host. Docker + Traefik covers routing and isolation needs for V2. |
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
