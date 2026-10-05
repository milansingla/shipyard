# Databases (PostgreSQL)

Code: [`modules/services/postgres.ts`](../apps/api/src/modules/services/postgres.ts) (rules),
[`PostgresProvisioner.ts`](../apps/api/src/modules/services/PostgresProvisioner.ts) (creation),
the prebuilt-image path of [`DeploymentEngine.run`](../apps/api/src/services/deployment/DeploymentEngine.ts),
`stopForReplacement` in [`DeploymentService`](../apps/api/src/modules/deployments/DeploymentService.ts).

> **This is a self-hosted database, not a managed one.** Shipyard runs the
> official PostgreSQL image in a container on this server, with its data on a
> Docker volume. There are **no automatic backups, no replicas or failover, no
> point-in-time recovery, no automatic upgrades, and no monitoring** beyond
> "is it running". If the server's disk is lost, the data is lost. For data
> you can't afford to lose, use a managed database (and set `DATABASE_URL`
> yourself), or set up backups as described below.

```
 web ──┐                    project network shipyard-p-<id>
 api ──┼── postgres://app:<password>@db:5432/app ──► db  (postgres:17-alpine)
 jobs ─┘                                               └─ volume shipyard-<service id>-data
                                                          → /var/lib/postgresql/data
```

## Adding one

Project page → **Add a service** → *PostgreSQL database*, or

```bash
curl -X POST …/api/projects/<id>/services -d '{"name": "db", "type": "POSTGRES", "version": 17}'
```

or in [shipyard.yaml](configuration.md):

```yaml
services:
  web: {}
  db:
    type: postgres
    version: 17        # 16 or 17; default 17
    resources:         # optional
      memoryMb: 512
```

In one transaction, Shipyard creates:

| What | Where | Who gets it |
| ---- | ----- | ----------- |
| The service `db`, image `postgres:17-alpine`, port 5432, private | `services` | |
| Volume `data` at `/var/lib/postgresql/data` | `volumes`, Docker volume `shipyard-<service id>-data` | |
| `POSTGRES_PASSWORD`: 32 random bytes, base64url | a **secret** scoped to `db` | only the database |
| `DATABASE_URL=postgres://app:<password>@db:5432/app` | a project-wide **secret** | every service, at runtime |

A second database in the same project gets `<NAME>_DATABASE_URL`
(`analytics` → `ANALYTICS_DATABASE_URL`). Both are ordinary secrets: visible
by name in **Environment**, encrypted at rest, never sent to a build, never
logged. Adding a database needs `SHIPYARD_SECRET_KEY`.

It starts on the next deploy. Role and database are both `app`.

## How it runs

- **Never built, never published**: no clone or build. The image is pulled
  once (`docker pull` only if it isn't on the server, so every deploy runs
  the same image). No port is published, not even on loopback: it is
  reachable only as `db:5432` on the project's private network.
- **Ready means accepting connections**: Docker runs `pg_isready -h
  127.0.0.1` inside the container every second. `-h 127.0.0.1` matters: while
  the image initialises a new data directory, its temporary server listens on
  a Unix socket only, so TCP readiness means the real server is up. Failures
  during the first 5 minutes don't count (initialising can be slow); the
  deployment waits up to its health timeout (default 2 minutes).
- **Started first**: in a project deploy, databases come before the apps
  that connect to them.
- **Left alone by project deploys**: **Deploy**, a push or `shipyard deploy`
  redeploy the apps but skip a database that is already running: restarting
  a database is never a side effect. Deploy the `db` service itself to
  restart it (e.g. after changing its resources).

### Stop first, never two servers on one data directory

Apps are redeployed with zero downtime: the new container starts, and the old
one stops only once the new one is live. That is **wrong for a database**:
two PostgreSQL servers on one data directory can corrupt it (each container
has its own process namespace, so PostgreSQL's lock file can't always tell).
So for a database, a deploy, restart or rollback:

1. stops the running server (`docker stop`, PostgreSQL's fast shutdown);
2. starts the new one on the same volume and waits for `pg_isready`;
3. if that fails, **restarts the previous server** (its history says
   `Restarted: its replacement failed`).

The database is unavailable for those few seconds. Apps should retry their
connections (most drivers and pools do).

## What you can change

- **Resources** (CPU, memory), in the dashboard, the API or shipyard.yaml.
- **Not the version.** A PostgreSQL major version can't read another's data
  directory. To upgrade: add a new database with the new version, then
  `pg_dump` from the old one and `psql` into the new one, switch
  `DATABASE_URL`, and delete the old one.
- **Not its storage**: its volume can't be detached or added to (409).
- `POSTGRES_PASSWORD` is only read when the data directory is first created.
  To rotate it, run `ALTER ROLE app PASSWORD '…'` in the database, then update
  both variables.

## Connecting from your machine

Nothing is published, on purpose. To get a shell:

```bash
docker exec -it <db container> psql -U app -d app
```

## Backups (do this yourself)

```bash
# dump
docker exec <db container> pg_dump -U app -d app -Fc > app-$(date +%F).dump
# restore into a database
docker exec -i <db container> pg_restore -U app -d app --clean < app.dump
```

Schedule the dump (cron on the host) and copy it off the server.

## Deleting

Deleting the `db` service (or its project) deletes the data for good, so it
needs `deleteData=true`; the dashboard asks you to type the name. Its
password and the URL variable that pointed at it are removed with it.

## Security

- The password is generated by Shipyard (256 bits) and stored encrypted; it
  never appears in logs, the build log or API responses.
- The server is reachable only from the project's own network: other
  projects' containers and the internet can't connect.
- Shipyard never deletes a prebuilt image like `postgres:17-alpine` when
  cleaning up a deployment (only images it built itself, by label): other
  projects may use it.
