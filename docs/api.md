# API reference

Shipyard's REST API is what the dashboard and the `shipyard` CLI use. Every
route below lives under `/api`, and the same routes are served under
**`/api/v1`**, the stable path for scripts and CI.

## Conventions

| | |
| --- | --- |
| **Base URL** | `http://localhost:4000/api` (or `/api` on the dashboard's own origin, which proxies it) |
| **Authentication** | a browser session cookie (`shipyard_session`, set by GitHub sign-in), **or** an API key: `Authorization: Bearer shp_…` |
| **Responses** | `{ "data": … }` on success; `{ "error": { "code", "message", "details?" } }` on failure |
| **Errors** | stable machine-readable `code`s (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `DOCKER_BUILD_FAILED`, …) with human-readable messages |
| **Authorization** | every request is checked against the caller's role in the project's organization: VIEWER < DEVELOPER < ADMIN < OWNER, raised by team grants. API keys can be scoped to `read`, `deploy` or `write` |
| **Safety** | state-changing browser requests must come from an allowed origin (CSRF); sign-in, webhooks and worker registration are rate-limited |
| **Async work** | starting a deployment returns **202** immediately; follow it with `GET /deployments/:id`, its events, or the live log stream |

```bash
# With an API key (create one in the dashboard → API keys)
export SHIPYARD_TOKEN=shp_…
curl -s -H "Authorization: Bearer $SHIPYARD_TOKEN" http://localhost:4000/api/v1/projects
```

## Health

| Method | Path | Does |
| --- | --- | --- |
| GET | `/health` | API and Docker reachability. No auth. `{"data":{"status":"ok","docker":"reachable"}}` |

## Authentication & users

| Method | Path | Does |
| --- | --- | --- |
| GET | `/auth/github/login` | starts GitHub OAuth sign-in (browser) |
| GET | `/auth/github/callback` | GitHub returns here; creates the session |
| GET | `/auth/me` | the signed-in user |
| POST | `/auth/logout` | ends the session |
| GET | `/api-keys` | your API keys (prefix only; a token is shown once, at creation) |
| POST | `/api-keys` | create a key: `name`, optional `expiresInDays`, `scopes` (`read` / `deploy` / `write`) |
| DELETE | `/api-keys/:id` | revoke a key |

## GitHub

| Method | Path | Does |
| --- | --- | --- |
| GET | `/github/repos?page=` | repositories you can deploy (repository picker) |
| GET | `/github/repos/:owner/:repo/branches` | branches of one repository |
| POST | `/webhooks/github` | push and pull-request webhooks (HMAC-signed, no session): deploy on push, previews per PR |

## Projects

| Method | Path | Does |
| --- | --- | --- |
| GET | `/projects` | your projects, each with its latest deployment |
| POST | `/projects` | create from `repositoryUrl` (+ optional `branch`, `name`, `organizationId`) |
| GET | `/projects/:id` | one project |
| PATCH | `/projects/:id` | settings: health check path/port/timeout, CPU/memory limits, restart policy, preview deployments |
| DELETE | `/projects/:id?deleteData=true` | delete with its containers, images, logs and public link (`deleteData=true` is required when it has volumes) |
| POST | `/projects/:id/deploy` | deploy the latest commit of every service (202) |
| GET | `/projects/:id/deployments?limit=` | deployment history, newest first |
| GET | `/projects/:id/metrics` | CPU, memory, restarts and uptime per service, plus deploy statistics |

## Deployments

| Method | Path | Does |
| --- | --- | --- |
| GET | `/deployments/:id` | one deployment: status, failed stage, error, URL, commit |
| GET | `/deployments/:id/events` | its timeline: who started it, every status change, why |
| GET | `/deployments/:id/logs?type=build\|runtime&tail=` | build or application logs |
| GET | `/deployments/:id/logs/stream?type=` | live logs as Server-Sent Events (`log`, then `end`) |
| POST | `/deployments/:id/stop` | stop (idempotent) |
| POST | `/deployments/:id/restart` | restart and health-check; on an older deployment, makes it live again |
| POST | `/deployments/:id/rollback` | bring back the previous working deployment, with zero downtime |
| POST | `/deployments/:id/redeploy` | deploy the latest commit again (202) |
| POST | `/deployments/:id/cancel` | cancel a queued deployment |
| GET | `/deployments/:id/approval` | approval state, when the organization requires approval for production |
| POST | `/deployments/:id/approve` · `/reject` | decide a deployment awaiting approval (ADMIN) |

## Services, volumes & databases

| Method | Path | Does |
| --- | --- | --- |
| GET | `/projects/:id/services` | services of a project (web, workers, PostgreSQL) |
| POST | `/projects/:id/services` | add a service; `{"type":"POSTGRES"}` adds a managed database and its `DATABASE_URL` |
| PATCH | `/services/:id` | service settings: commands, port, replicas, resources, public/private |
| DELETE | `/services/:id` | remove a service |
| POST | `/services/:id/deploy` | deploy one service (202) |
| GET | `/services/:id/volumes` | its persistent volumes |
| POST | `/services/:id/volumes` | attach a volume at a mount path |
| DELETE | `/volumes/:id` | detach (the data is kept unless explicitly deleted) |

## Environments & variables

| Method | Path | Does |
| --- | --- | --- |
| GET | `/projects/:id/environments` | development environment and pull-request previews |
| POST | `/projects/:id/environments` | create the development environment for a branch |
| PATCH | `/environments/:id` | change its branch |
| POST | `/environments/:id/deploy` | deploy it (202) |
| POST | `/environments/:id/close` | close it and remove its containers |
| GET | `/projects/:id/env` | variables (secret values are never returned) |
| PUT | `/projects/:id/env/:key?service=&environment=` | set `value`, `secret`, `target` (`RUNTIME` / `BUILD` / `BOTH`); scope it with `?service=<id>` and `?environment=PRODUCTION\|PREVIEW\|DEVELOPMENT` (default: every service, `ALL`) |
| DELETE | `/projects/:id/env/:key?service=&environment=` | remove; applies on the next deploy |

## Domains & public links

| Method | Path | Does |
| --- | --- | --- |
| GET | `/projects/:id/domains` | custom domains |
| POST | `/projects/:id/domains` | add a hostname; live immediately through Traefik (HTTPS with Let's Encrypt in production) |
| DELETE | `/projects/:id/domains/:hostname` | remove it |
| GET | `/projects/:id/public-link` | the free public link: `state` (`absent`, `starting`, `live`, `failed`), `url`, `detail` |
| POST | `/projects/:id/public-link` | create it, or get a new address: a `https://….trycloudflare.com` Cloudflare quick tunnel to the live app (ADMIN, audited) |
| DELETE | `/projects/:id/public-link` | turn it off |

## Cron jobs

| Method | Path | Does |
| --- | --- | --- |
| GET | `/projects/:id/cron-jobs` | scheduled jobs (UTC) |
| POST | `/projects/:id/cron-jobs` | create: `name`, `schedule`, `command`, `serviceId`, `timeoutSeconds` |
| PATCH | `/cron-jobs/:id` | edit, pause or resume |
| DELETE | `/cron-jobs/:id` | delete |
| POST | `/cron-jobs/:id/run` | run now |
| GET | `/cron-jobs/:id/runs?limit=` | recent runs |
| GET | `/cron-runs/:id` | one run, with its output |

## Organizations, teams & access

| Method | Path | Does |
| --- | --- | --- |
| GET | `/organizations` | your organizations and your role in each |
| POST | `/organizations` | create one |
| GET | `/organizations/:id/members` | members and roles |
| POST | `/organizations/:id/members` | add a member by GitHub login, with a role |
| PATCH | `/organizations/:id/members/:userId` | change a role |
| DELETE | `/organizations/:id/members/:userId` | remove a member |
| GET | `/organizations/:id/teams` | teams and their project grants |
| POST | `/organizations/:id/teams` | create a team |
| DELETE | `/teams/:id` | delete a team |
| POST | `/teams/:id/members` · DELETE `/teams/:id/members/:userId` | team membership |
| PUT | `/teams/:id/projects/:projectId` · DELETE same | grant or revoke a role on one project |
| GET | `/organizations/:id/service-accounts` | automation identities (API keys only, no sign-in) |
| POST | `/organizations/:id/service-accounts` | create one with a fixed role |
| DELETE | `/service-accounts/:id` | delete it |
| POST | `/service-accounts/:id/keys` · DELETE `/service-accounts/:id/keys/:keyId` | its API keys |
| GET | `/organizations/:id/policy` | resource caps, health-check rule, allowed domains, production approval |
| PATCH | `/organizations/:id/policy` | change the policy (OWNER) |
| GET | `/audit-logs?projectId=&action=&q=&limit=&before=` | searchable audit log (`action` takes comma-separated names, `q` free text, `before` pages back) |

## Alerts & notifications

| Method | Path | Does |
| --- | --- | --- |
| GET | `/alerts?status=OPEN\|RESOLVED&limit=` | open and resolved alerts (failed deploys, apps down, CPU/memory, offline workers) |
| GET | `/notification-channels` · `/organizations/:id/notification-channels` | where alerts are sent |
| POST | `/notification-channels` · `/organizations/:id/notification-channels` | add a webhook or Slack channel |
| POST | `/notification-channels/:id/test` | send a test alert |
| DELETE | `/notification-channels/:id` | remove a channel |

## AI assistant

Read-only and advisory: it can only see what the caller can see, and never
changes anything itself.

| Method | Path | Does |
| --- | --- | --- |
| POST | `/ai/deployments/:id/diagnosis` | why a deployment failed, and what to change |
| POST | `/ai/alerts/:id/summary` | an incident summary |
| POST | `/ai/projects/:id/analysis` | how the repository should be built and run |
| POST | `/ai/projects/:id/dockerfile` | a suggested Dockerfile |
| POST | `/ai/ask` | a question about your projects; may return proposed actions for you to confirm |

## Workers

Used by worker machines (`npm run worker -w @shipyard/api`) with their own
secret; listing and draining need OWNER.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/workers` | registered machines, capacity, state |
| POST | `/workers/register` | join with a join token (rate-limited) |
| POST | `/workers/:id/heartbeat` · `/disconnect` | liveness |
| POST | `/workers/:id/drain` · `/undrain` | stop or resume scheduling onto a machine |
| POST | `/workers/:id/calls/next` | long-poll for the next engine call |
| POST | `/workers/:id/calls/:callId/events` · `/complete` | stream progress and results back |

## Example: deploy and follow

```bash
api() { curl -s -H "Authorization: Bearer $SHIPYARD_TOKEN" -H 'content-type: application/json' "http://localhost:4000/api/v1$@"; }

# 1. Create a project from a repository
api /projects -X POST -d '{"repositoryUrl":"https://github.com/<owner>/<repo>","branch":"main"}'

# 2. Deploy it: 202, the pipeline runs in the background
api /projects/<projectId>/deploy -X POST

# 3. Follow it: QUEUED → CLONING → DETECTING → BUILDING → STARTING → HEALTH_CHECKING → HEALTHY → ROUTING → RUNNING
api /deployments/<deploymentId>
curl -N -H "Authorization: Bearer $SHIPYARD_TOKEN" "http://localhost:4000/api/v1/deployments/<deploymentId>/logs/stream?type=build"
```
