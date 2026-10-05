# Shipyard 🚢

A small, understandable, self-hosted deployment platform — think a tiny
Render/Railway you can read end to end.

```
GitHub repo → clone → detect → docker build → container → health check → URL
```

> **Status: V2, Milestone 5.** A dashboard to sign in with GitHub, pick a
> repository and branch, deploy, and follow each deployment's stages and logs.
> Behind it: a REST API with background deployments, per-user projects,
> deployment history in PostgreSQL, and Dockerfile generation for Node.js apps.
> Push-to-deploy webhooks and Traefik routing are next.
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

Then set up GitHub sign-in (one-time, ~2 minutes): create a GitHub OAuth App and
fill `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SHIPYARD_SECRET_KEY` and
`SHIPYARD_ALLOWED_GITHUB_USERS` in `.env` — step by step in
[docs/github.md](docs/github.md#setup).

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

## Run Shipyard

```bash
npm run dev:api   # terminal 1 — API on http://localhost:4000
npm run dev:web   # terminal 2 — dashboard on http://localhost:3000
```

Open <http://localhost:3000>, sign in with GitHub, choose **New project**, pick
a repository and branch, and **Create and deploy**. The deployment page follows
the pipeline stage by stage and streams the build log.

The dashboard proxies `/api/*` to the API, so the browser only ever talks to
one origin (no CORS; the session cookie and CSRF checks work unchanged). See
[docs/dashboard.md](docs/dashboard.md).

### Use the API directly

```bash
curl http://localhost:4000/api/health # {"data":{"status":"ok","docker":"reachable"}}
```

Sign in through the dashboard, then copy the `shipyard_session` cookie
(browser dev tools → Application → Cookies) for curl:

```bash
export S='shipyard_session=<value>'
alias api='curl -s -b "$S"'

# 1. Create a project (repository + branch are checked against GitHub now, not at deploy time)
api -X POST localhost:4000/api/projects -H 'content-type: application/json' \
  -d '{"repositoryUrl":"https://github.com/<owner>/<repo>","branch":"main"}'

# 2. Deploy — returns 202 immediately; the pipeline runs in the background
api -X POST localhost:4000/api/projects/<projectId>/deploy

# 3. Watch it: status goes PENDING → CLONING → BUILDING → STARTING → HEALTHY → RUNNING
api localhost:4000/api/deployments/<deploymentId>
api 'localhost:4000/api/deployments/<deploymentId>/logs?type=build'
api 'localhost:4000/api/deployments/<deploymentId>/logs?type=runtime&tail=100'
```

| Endpoint                                   | Does                                              |
| ------------------------------------------ | ------------------------------------------------- |
| `GET /api/auth/github/login` · `GET /api/auth/me` · `POST /api/auth/logout` | sign in (browser) · current user · sign out |
| `GET /api/github/repos` · `GET /api/github/repos/:owner/:repo/branches` | repository & branch pickers |
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

Everything except `/api/health` and sign-in requires a session; you only see
your own projects. Responses are `{ "data": … }` or
`{ "error": { "code", "message", "details?" } }`.

## Tests

```bash
npm test                  # unit tests — fast, no Docker or network needed
npm run test:integration  # real Docker, PostgreSQL (shipyard_test, reset each run) and GitHub clone
npm run typecheck
```

## Repository layout

```
apps/web/            Next.js dashboard (proxies /api to apps/api)
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
- [GitHub](docs/github.md) — sign-in setup, sessions, authorization, repository selection
- [Dashboard](docs/dashboard.md) — how the web app talks to the API, and its visual language
- [Security](docs/security.md) — threat model and what is (not yet) safe
- [Learning notes](docs/learning-notes.md) — concepts + interview prep per milestone

## Roadmap

- [x] **M1** TypeScript foundation, status model, health checks, tests
- [x] **M2** PostgreSQL + Prisma, REST deployment API, deployment history
- [x] **M3** Node.js project detection + Dockerfile generation
- [x] **M4** GitHub OAuth, repository & branch selection
- [x] **M5** Next.js dashboard
- [ ] **M6** GitHub webhooks (auto-deploy on push)
- [ ] **M7** Traefik routing, zero-downtime redeploy
