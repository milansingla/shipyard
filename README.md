# Shipyard 🚢

A small, understandable, self-hosted deployment platform — think a tiny
Render/Railway you can read end to end.

```
GitHub repo → clone → detect → docker build → container → health check → URL
```

> **Status: V2, Milestone 3.** Projects and deployment history in PostgreSQL,
> a REST API with background deployments and logs, and Dockerfile generation
> for Node.js apps. GitHub OAuth, the dashboard, webhooks and Traefik are next.
> ⚠️ The API has **no authentication yet** (M4) — keep it on `127.0.0.1`.
> See [the roadmap](#roadmap).

## Requirements

| Tool           | Version | Check                     |
| -------------- | ------- | ------------------------- |
| Node.js        | ≥ 22.12 | `node -v`                 |
| npm            | ≥ 10    | `npm -v`                  |
| Docker Desktop | running | `docker version`          |
| git            | any     | `git --version`           |

## Setup

```bash
npm install
cp .env.example .env      # optional — every variable has a safe default
npm run db:up             # PostgreSQL in Docker on 127.0.0.1:5433
npm run db:deploy         # apply migrations
```

## Deploy something (CLI)

```bash
# Any public GitHub repo with a Dockerfile — or a Node.js app (package.json) without one
npm run shipyard -- deploy https://github.com/<owner>/<repo>
npm run shipyard -- deploy https://github.com/<owner>/<repo> --branch develop

# Manage it using the container name printed by deploy
npm run shipyard -- logs    shipyard-<repo>-<id> [--tail 100]
npm run shipyard -- restart shipyard-<repo>-<id>
npm run shipyard -- stop    shipyard-<repo>-<id>
```

A sample app lives in [`examples/hello-node`](examples/hello-node) — push it to
a GitHub repo of your own to try a full deployment.

**Your app must** listen on `0.0.0.0` and on the port in `$PORT` (Shipyard sets
it to the Dockerfile's `EXPOSE` port, or 3000 when there is none or when
Shipyard generated the Dockerfile — see [build detection](docs/deployment-engine.md#build-detection--dockerfile-generation)).

## Run the API

```bash
npm run dev:api                       # http://localhost:4000, auto-reload
curl http://localhost:4000/api/health # {"data":{"status":"ok","docker":"reachable"}}
```

Deploy through the API:

```bash
# 1. Create a project (repository + branch are checked against GitHub now, not at deploy time)
curl -X POST localhost:4000/api/projects -H 'content-type: application/json' \
  -d '{"repositoryUrl":"https://github.com/<owner>/<repo>","branch":"main"}'

# 2. Deploy — returns 202 immediately; the pipeline runs in the background
curl -X POST localhost:4000/api/projects/<projectId>/deploy

# 3. Watch it: status goes PENDING → CLONING → BUILDING → STARTING → HEALTHY → RUNNING
curl localhost:4000/api/deployments/<deploymentId>
curl 'localhost:4000/api/deployments/<deploymentId>/logs?type=build'
curl 'localhost:4000/api/deployments/<deploymentId>/logs?type=runtime&tail=100'
```

| Endpoint                                   | Does                                              |
| ------------------------------------------ | ------------------------------------------------- |
| `POST /api/projects`                       | create (`repositoryUrl`, optional `branch`, `name`) |
| `GET /api/projects` · `GET /api/projects/:id` | list / get, with latest deployment             |
| `DELETE /api/projects/:id`                 | remove project, its containers, images and logs   |
| `POST /api/projects/:id/deploy`            | new deployment (202)                              |
| `GET /api/projects/:id/deployments?limit=` | deployment history, newest first                  |
| `GET /api/deployments/:id`                 | one deployment                                    |
| `GET /api/deployments/:id/logs?type=build\|runtime&tail=` | logs                              |
| `POST /api/deployments/:id/stop`           | stop (idempotent)                                 |
| `POST /api/deployments/:id/restart`        | restart + health check; on an old deployment = rollback |
| `POST /api/deployments/:id/redeploy`       | new deployment of the same project (202)          |

Responses are `{ "data": … }` or `{ "error": { "code", "message", "details?" } }`.

## Tests

```bash
npm test                  # unit tests — fast, no Docker or network needed
npm run test:integration  # real Docker, PostgreSQL (shipyard_test, reset each run) and GitHub clone
npm run typecheck
```

## Repository layout

```
apps/api/            Express API + CLI + deployment engine (TypeScript)
  prisma/            schema + migrations
  src/modules/       projects, deployments (HTTP routes + database rules)
  src/services/      git, docker, detection, build, deployment engine, workspace
  test/unit/         fast tests
  test/integration/  real Docker / network tests
examples/hello-node/ sample deployable app
docs/                architecture, engine, database, security, learning notes
phase-1/             the original V0.1 JavaScript prototype (kept for reference)
```

## Documentation

- [Architecture](docs/architecture.md) — components and why they are split this way
- [Deployment engine](docs/deployment-engine.md) — pipeline, statuses, health checks, debugging
- [Database](docs/database.md) — schema and persistence decisions
- [Security](docs/security.md) — threat model and what is (not yet) safe
- [Learning notes](docs/learning-notes.md) — concepts + interview prep per milestone

## Roadmap

- [x] **M1** TypeScript foundation, status model, health checks, tests
- [x] **M2** PostgreSQL + Prisma, REST deployment API, deployment history
- [x] **M3** Node.js project detection + Dockerfile generation
- [ ] **M4** GitHub OAuth, repository & branch selection
- [ ] **M5** Next.js dashboard
- [ ] **M6** GitHub webhooks (auto-deploy on push)
- [ ] **M7** Traefik routing, zero-downtime redeploy
