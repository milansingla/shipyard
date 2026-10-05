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
Project 1 ──── * Deployment
```

### Project
A repository + branch Shipyard knows how to deploy.

| Field                                | Notes                                                              |
| ------------------------------------ | ------------------------------------------------------------------ |
| `slug` (unique)                      | URL/Docker-safe form of `name`; used in container/image names and, from M7, hostnames |
| `repositoryUrl`                      | Normalised HTTPS clone URL, validated against the host allowlist   |
| `repositoryOwner`, `repositoryName`  | Parsed once at creation; avoids re-parsing for display             |
| `branch`                             | Resolved against the real remote at creation (default branch if omitted) |

### Deployment
One attempt to build and run a project at one commit. **Rows are never
re-pointed at another commit**: a redeploy creates a new row. That append-only
history is what makes "what was running at 14:02?" and rollback possible.

| Field                                 | Notes                                                        |
| ------------------------------------- | ------------------------------------------------------------ |
| `status`                              | `DeploymentStatus` enum — see [deployment-engine.md](deployment-engine.md) |
| `branch`                              | Copied from the project at deploy time (the project may change later) |
| `commitSha`                           | Exact commit built; set after clone                          |
| `imageName`, `containerName`          | Deterministic from slug + id, so known before Docker runs    |
| `containerId`, `hostPort`, `deploymentUrl` | Filled as the deployment progresses; cleared on stop     |
| `errorMessage`                        | Why it FAILED — kept in the DB even if the log file is lost  |
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

## Known limits

- The "one deployment per project at a time" lock is in memory: correct for one
  API process only. Moving it into PostgreSQL is planned for V3.
- No `User` model yet — projects have no owner until GitHub OAuth (M4).

## Tests

Integration tests use a separate `shipyard_test` database, recreated from the
migrations before each run. Test helpers refuse any database whose name does
not end in `_test`.
