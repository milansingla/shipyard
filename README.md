# Shipyard 🚢

A small, understandable, self-hosted deployment platform — think a tiny
Render/Railway you can read end to end.

```
GitHub repo → clone → detect → docker build → container → health check → http://<project>.localhost
```

> **Status: V5 — a self-hosted platform across machines.** Sign in
> with GitHub, pick a repository, deploy. A project is a set of services (web,
> workers, PostgreSQL) on a private network, declared in the dashboard or in
> `shipyard.yaml`, with persistent volumes, replicas and rolling deploys, cron
> jobs, a development environment and a preview per pull request. Every project
> lives at a stable address (or your own domain over HTTPS) and switches
> traffic with zero downtime. Deploys queue and run on any registered worker
> machine; metrics, alerts, backups and cleanup keep it running; teams,
> service accounts, scoped API keys, policies and approvals govern who does
> what; an AI assistant explains failures without being able to change
> anything. See [the roadmap](#roadmap).

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
npm run db:up             # PostgreSQL (127.0.0.1:5433) and Traefik (127.0.0.1:80) in Docker
npm run db:deploy         # apply migrations
```

Set `SHIPYARD_PUBLIC_DOMAIN=localhost` in `.env` to reach each project at
`http://<project>.localhost` through Traefik (port 80 taken? set
`SHIPYARD_HTTP_PORT`). Without it, each deployment gets its own
`http://localhost:<port>` URL. See [docs/routing.md](docs/routing.md).

Then set up GitHub sign-in (one-time, ~2 minutes): create a GitHub OAuth App and
fill `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SHIPYARD_SECRET_KEY` and
`SHIPYARD_ALLOWED_GITHUB_USERS` in `.env` — step by step in
[docs/github.md](docs/github.md#setup).

## The `shipyard` CLI

Create an API key in the dashboard (**API keys**), then:

```bash
npm run shipyard -- login --url http://localhost:3000 --token shp_…
npm run shipyard -- projects
npm run shipyard -- deploy shop            # streams the build, exits 0 once live, 1 if it failed
npm run shipyard -- status shop
npm run shipyard -- logs shop --follow     # the app's output; --build for the build log
npm run shipyard -- rollback shop
npm run shipyard -- env shop set DATABASE_URL=postgres://… --secret
```

It only talks to the API, as you, with your team roles. In CI, set
`SHIPYARD_URL` and `SHIPYARD_TOKEN` instead of logging in. Details:
[docs/cli.md](docs/cli.md).

`npm run shipyard:local -- deploy <repo-url>` is the older engine-only tool:
it deploys straight through Docker on this machine, without the database or
API. It's kept for working on the deployment engine itself.

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
the pipeline stage by stage and streams the build log. Once RUNNING, the app is
live at `http://<project>.localhost`, and stays at that address across
redeploys.

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

# 3. Watch it: QUEUED → CLONING → DETECTING → BUILDING → STARTING → HEALTH_CHECKING → HEALTHY → ROUTING → RUNNING
api localhost:4000/api/deployments/<deploymentId>
api 'localhost:4000/api/deployments/<deploymentId>/logs?type=build'
api 'localhost:4000/api/deployments/<deploymentId>/logs?type=runtime&tail=100'
```

| Endpoint                                   | Does                                              |
| ------------------------------------------ | ------------------------------------------------- |
| `GET /api/auth/github/login` · `GET /api/auth/me` · `POST /api/auth/logout` | sign in (browser) · current user · sign out |
| `GET /api/github/repos` · `GET /api/github/repos/:owner/:repo/branches` | repository & branch pickers |
| `GET /api/audit-logs?projectId=&limit=&before=` | who did what (Activity page) |
| `GET/POST /api/projects/:id/services` · `PATCH/DELETE /api/services/:id` · `POST /api/services/:id/deploy` | services — see [docs/services.md](docs/services.md); `{"type": "POSTGRES"}` adds a database ([docs/databases.md](docs/databases.md)) |
| `GET/POST /api/services/:id/volumes` · `DELETE /api/volumes/:id` | persistent volumes (detaching keeps the data) |
| `GET/POST /api/projects/:id/environments` · `PATCH /api/environments/:id` · `POST /api/environments/:id/deploy` · `…/close` | environments — see [docs/environments.md](docs/environments.md) |
| `GET/POST /api/projects/:id/cron-jobs` · `PATCH/DELETE /api/cron-jobs/:id` · `POST /api/cron-jobs/:id/run` · `GET /api/cron-jobs/:id/runs` · `GET /api/cron-runs/:id` | cron jobs — see [docs/cron.md](docs/cron.md) |
| `GET/POST /api/organizations` · `…/:id/members` | teams and members — see [docs/teams.md](docs/teams.md) |
| `GET/POST /api/api-keys` · `DELETE /api/api-keys/:id` | API keys for the CLI/scripts (`Authorization: Bearer shp_…`) |
| `POST /api/projects`                       | create (`repositoryUrl`, optional `branch`, `name`) |
| `GET /api/projects` · `GET /api/projects/:id` | list / get, with latest deployment             |
| `PATCH /api/projects/:id`                  | settings: `healthCheckPath`, `healthCheckPort`, `healthCheckTimeoutSeconds`, `cpuLimit`, `memoryLimitMb`, `restartPolicy` |
| `DELETE /api/projects/:id`                 | remove project, its containers, images and logs   |
| `POST /api/projects/:id/deploy`            | new deployment (202)                              |
| `GET /api/projects/:id/deployments?limit=` | deployment history, newest first                  |
| `GET /api/projects/:id/env`                | environment variables (secrets: value hidden)     |
| `GET/POST /api/projects/:id/domains` · `DELETE …/domains/:hostname` | custom domains, live immediately |
| `PUT /api/projects/:id/env/:key` · `DELETE …` | set (`value`, `secret`, `target`) · remove — applies on next deploy |
| `GET /api/deployments/:id`                 | one deployment                                    |
| `GET /api/deployments/:id/events`          | its history: created by whom, every status change, why |
| `GET /api/deployments/:id/logs?type=build\|runtime&tail=` | logs                              |
| `GET /api/deployments/:id/logs/stream?type=…` | live logs (Server-Sent Events: `log`, then `end`) |
| `POST /api/deployments/:id/stop`           | stop (idempotent)                                 |
| `POST /api/deployments/:id/restart`        | restart + health check; on an old deployment = rollback to it |
| `POST /api/deployments/:id/rollback`       | bring back the previous working deployment (idempotent) |
| `POST /api/deployments/:id/redeploy`       | new deployment of the same project (202)          |
| `POST /api/webhooks/github`                | GitHub push webhook (HMAC-signed; no session)     |

Everything except `/api/health` and sign-in requires a session; you only see
your own projects. Responses are `{ "data": … }` or
`{ "error": { "code", "message", "details?" } }`.

## Tests

```bash
npm test                  # unit tests — fast, no Docker or network needed
npm run test:integration  # real Docker, Traefik, PostgreSQL (shipyard_test, reset each run) and GitHub clone
npm run typecheck
```

## Repository layout

```
apps/web/            Next.js dashboard (proxies /api to apps/api)
apps/api/            Express API + CLI + deployment engine (TypeScript)
  prisma/            schema + migrations
  src/modules/       projects, deployments (HTTP routes + database rules)
  src/services/      git, docker, detection, build, deployment engine, routing, workspace
  test/unit/         fast tests
  test/integration/  real Docker / network tests
examples/hello-node/ sample deployable app
docs/                architecture, engine, database, security, learning notes
phase-1/             the original V0.1 JavaScript prototype (kept for reference)
```

## Documentation

- [Architecture](docs/architecture.md) — components and why they are split this way
- [Deployment engine](docs/deployment-engine.md) — pipeline, statuses, health checks, debugging
- [Routing](docs/routing.md) — Traefik, stable hostnames, zero-downtime redeploys
- [Configuration as code](docs/configuration.md) — `shipyard.yaml`, and which setting wins
- [Services](docs/services.md) — multi-service projects, private networking, per-service settings, volumes
- [Databases](docs/databases.md) — self-hosted PostgreSQL services, `DATABASE_URL`, backups
- [Cron jobs](docs/cron.md) — scheduled commands in a service's image, with every run recorded
- [Access control](docs/rbac.md) — roles, teams, service accounts, API key scopes
- [AI assistant](docs/ai.md) — diagnosis, incident summaries, repository analysis, questions; what it can and can't do
- [Workers](docs/workers.md) — worker machines, the deploy queue, scheduler and leases
- [Observability](docs/observability.md) — metrics · [Operations](docs/operations.md) — alerts, backups, restore, cleanup, disaster recovery
- [Environments](docs/environments.md) — production, development, pull-request previews; variables per environment
- [Teams & roles](docs/teams.md) — organizations, OWNER/ADMIN/DEVELOPER/VIEWER, what each may do
- [Environment variables & secrets](docs/environment.md) — encrypted per-project config, runtime vs build
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
- [x] **M6** GitHub webhooks (auto-deploy on push)
- [x] **M7** Traefik routing, zero-downtime redeploy — **V2 released (v2.0.0)**

### V3 — production deployment platform (v3.0.0)

- [x] Deployment state machine: QUEUED → CLONING → DETECTING → BUILDING →
      STARTING → HEALTH_CHECKING → HEALTHY → ROUTING → RUNNING, ROLLING_BACK,
      recorded failure stage
- [x] Environment variables & secrets (encrypted, runtime/build, never shown or baked into images)
- [x] Health checks per project (path, port, timeout)
- [x] CPU/memory limits and restart policy per project
- [x] Deployment history: who started it, every status, why
- [x] One-click rollback to the previous working deployment
- [x] Live build and runtime logs (Server-Sent Events)
- [x] Custom domains, HTTPS via Let's Encrypt (production compose override)
- [x] Rate limiting

### V4 — developer platform (v4.0.0)

- [x] API keys (hashed, shown once) and the `shipyard` CLI
- [x] Audit log; organizations with OWNER/ADMIN/DEVELOPER/VIEWER roles
- [x] Build cache (dependency installs reused) and an image registry abstraction
- [x] Multi-service projects with private networking; `shipyard.yaml`
- [x] Persistent volumes; self-hosted PostgreSQL services
- [x] Replicas and rolling deployments, load-balanced by Traefik
- [x] Cron jobs with recorded runs
- [x] Development environments, per-environment variables, pull request previews

### V5 — full platform (v5.0.0, final)

- [x] Workers: registration with a join token, heartbeats, draining, remote execution (`npm run worker -w @shipyard/api`)
- [x] Deploy queue in PostgreSQL: priorities, FIFO per project, leases, recovery of lost workers, scheduling by capacity and affinity
- [x] Metrics (CPU, memory, restarts, uptime) and alerts to webhooks and Slack
- [x] Backups and tested restores (Shipyard's database, PostgreSQL services, volumes); hourly cleanup
- [x] Teams with per-project grants, service accounts, API key scopes (read / deploy / write)
- [x] Searchable audit log, versioned API (`/api/v1`), CLI domains
- [x] Organization policies (resource caps, health checks, domain suffixes) and production deploy approval
- [x] AI assistant: deployment diagnosis, incident summaries, repository analysis, Dockerfile help, questions with proposed actions ([docs/ai.md](docs/ai.md))
