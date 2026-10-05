# Database

PostgreSQL 17 (local: `docker compose`, port 5433) accessed through Prisma 7
with the `pg` driver adapter. Schema: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).

```bash
npm run db:up        # start PostgreSQL (data kept in the shipyard-postgres volume)
npm run db:deploy    # apply committed migrations
npm run db:migrate   # after editing schema.prisma: create + apply a new migration
npm run db:studio    # browse data
npm run db:down      # stop (data kept); `docker compose down -v` deletes it
```

## Model

```
User 1 ──── * Session
  1
  └──── * Project 1 ──── * Deployment
```

### User and Session
Created by GitHub sign-in — see [github.md](github.md). `User.githubId` (GitHub's
numeric id, `BIGINT`) is the identity; `login` is display data refreshed at each
sign-in. `githubAccessToken` is AES-256-GCM ciphertext. `Session.id` is
sha256 of the cookie token, so the table alone can't be used to impersonate anyone.
Deleting a user cascades to sessions but is **restricted** while they own
projects: project deletion must run first because it also removes containers.

### Project
A repository + branch Shipyard knows how to deploy.

| Field                                | Notes                                                              |
| ------------------------------------ | ------------------------------------------------------------------ |
| `ownerId`                            | The user who created it; every query is scoped by it |
| `slug` (unique)                      | URL/Docker-safe form of `name`; used in container/image names and hostnames (`<slug>.<SHIPYARD_PUBLIC_DOMAIN>`) |
| `repositoryUrl`                      | Normalised HTTPS clone URL, validated against the host allowlist   |
| `repositoryOwner`, `repositoryName`  | Parsed once at creation; avoids re-parsing for display             |
| `branch`                             | Resolved against the real remote at creation (default branch if omitted) |

### Deployment
One attempt to build and run a project at one commit. **Rows are never
re-pointed at another commit**: a redeploy creates a new row. That append-only
history is what makes "what was running at 14:02?" and rollback possible.

| Field                                 | Notes                                                        |
| ------------------------------------- | ------------------------------------------------------------ |
| `trigger`                             | `MANUAL` or `PUSH` (GitHub webhook) |
| `status`                              | `DeploymentStatus` enum — see [deployment-engine.md](deployment-engine.md) |
| `branch`                              | Copied from the project at deploy time (the project may change later) |
| `commitSha`                           | Exact commit built; set after clone                          |
| `imageName`, `containerName`          | Deterministic from slug + id, so known before Docker runs    |
| `containerId`, `hostPort`, `deploymentUrl` | Filled as the deployment progresses; cleared on stop. `deploymentUrl` is the stable `http://<slug>.<domain>` with routing on, else `http://localhost:<hostPort>` |
| `errorMessage`                        | Why it FAILED — kept in the DB even if the log file is lost  |
| `failedStage`                         | Stage it was in when it FAILED (null before V3)              |
| `startedAt`, `finishedAt`             | Timing of the pipeline                                       |

Indexes: `(projectId, createdAt DESC)` for history pages, `status` for
startup reconciliation queries.

## Decisions

**The DB enum must match `status.ts`.** PostgreSQL stores which statuses exist;
the TypeScript transition table decides which moves are legal. A unit test
(`schema.test.ts`) fails if the two lists drift apart.

**Race-safe status updates.** Status changes use
`UPDATE … WHERE id = $1 AND status = <status we read>`. If another operation
changed the row in between, zero rows match and the caller gets a 409 instead
of silently overwriting (optimistic concurrency, no locks held).

**Build logs are files, not rows.** `<SHIPYARD_DATA_DIR>/logs/<deploymentId>.log`.
Builds print thousands of lines; one UPDATE per line would bloat the table.
The DB keeps the metadata (status, `errorMessage`). See `BuildLogStore.ts`.

**Deleting a project** removes its containers and images first, then the rows
(deployments cascade). If Docker is unreachable, nothing is deleted, so no
container is orphaned without a record.

**Startup reconciliation.** Deployments run inside the API process. If it stops
mid-deploy, rows stuck in CLONING/BUILDING/… are marked FAILED on the next start,
and RUNNING rows are checked against Docker (`DeploymentService.reconcileOnStartup`).

### WebhookDelivery
One row per accepted GitHub webhook, keyed by GitHub's `X-GitHub-Delivery` id,
with a human-readable `outcome`. The row is inserted **before** acting, so a
retried or redelivered webhook hits the primary key and is skipped. If handling
fails, the row is deleted again so GitHub's retry can succeed. Rows older than
30 days are pruned at startup.

### EnvironmentVariable (`environment_variables`)

| Column | Notes |
| ------ | ----- |
| `projectId` + `key` (unique) | Deleted with the project (cascade) |
| `value` | SecretBox ciphertext (`v1:…`), never plaintext, bound to `env:<projectId>:<key>` |
| `secret` | Value never returned by the API |
| `target` | `RUNTIME` · `BUILD` · `BOTH` (secrets: `RUNTIME` only) |

See [environment.md](environment.md).

## Known limits

- The route table Traefik reads (`<SHIPYARD_DATA_DIR>/traefik/routes.yml`) is
  *derived* from this database (one route per RUNNING deployment) and rebuilt
  at startup; it is never read back as a source of truth.

- The "one deployment per project at a time" lock is in memory: correct for one
  API process only. Moving it into PostgreSQL is planned for V3.
- Slugs are unique across all users (they become container names and
  hostnames), so two users can't both have a project named `api`.

## Tests

Integration tests use a separate `shipyard_test` database, recreated from the
migrations before each run. Test helpers refuse any database whose name does
not end in `_test`.
