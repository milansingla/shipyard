# Operations

Running Shipyard day to day: alerts, backups and restore, cleanup, disaster recovery.

## Alerts

Code: [`modules/alerts/`](../apps/api/src/modules/alerts/), providers in
[`services/notify/`](../apps/api/src/services/notify/NotificationProvider.ts).
Dashboard → **Alerts**, or `GET /api/alerts?status=OPEN`.

| Alert | Opens when | Resolves when | Severity |
| ----- | ---------- | ------------- | -------- |
| `DEPLOYMENT_FAILED` | a production deploy of a service fails | a later deploy of it succeeds | warning |
| `APP_DOWN` | fewer replicas running than deployed (crashed, crash-looping) | all run again, or it's replaced | critical |
| `HIGH_CPU` | CPU above 90% of its limit (1 CPU per replica without one) for 5 samples (2.5 min) | it drops below | warning |
| `HIGH_MEMORY` | memory above 90% of its limit for 5 samples | it drops below | warning |
| `WORKER_OFFLINE` | a worker misses its heartbeats | it heartbeats again | critical |
| `DISK_PRESSURE` | a worker reports under 10% free disk | it has more | critical |

- **One alert per problem**: an open alert with the same fingerprint (say
  `HIGH_CPU:<deployment>`) is reused, enforced by a partial unique index. Its
  channels are told when it opens and when it resolves, not every minute.
- Checks run every 60 s on the metric samples ([observability.md](observability.md));
  deploy and worker alerts are raised as they happen.
- Previews and development environments never alert.
- Project alerts belong to the project's organization; worker alerts are the
  platform's, seen by `SHIPYARD_ADMINS`.

### Channels

Organization admins add channels on the Alerts page, or
`POST /api/organizations/:id/notification-channels {"name", "type": "SLACK" | "WEBHOOK", "url"}`.
Platform channels (worker alerts): `POST /api/notification-channels` (`SHIPYARD_ADMINS`).
**Send a test** checks one.

- **Webhook**: `POST` JSON `{kind, severity, status, title, message, project, url, at}`.
- **Slack**: an incoming webhook; one line with a link to the dashboard.
- Alerting talks to a `NotificationProvider`; adding email or PagerDuty is a
  new provider, not a change to how alerts work.
- **The URL is a credential** (anyone with a Slack webhook URL can post to the
  channel): stored encrypted, never returned; only its host is shown.
- **No requests into the private network**: Shipyard requests these URLs from
  inside your network, so a channel must be `https` and its host must resolve
  to public addresses only (checked when added and before every send;
  redirects aren't followed). Otherwise a "webhook" could reach the database,
  localhost services or cloud metadata. `SHIPYARD_ALLOW_PRIVATE_WEBHOOKS=true`
  lifts this for local development.
- Delivery is best effort (5 s timeout); the last failure is shown on the channel.

## Backups

Code: [`ops/BackupService.ts`](../apps/api/src/ops/BackupService.ts),
proven by [`backup.integration.test.ts`](../apps/api/test/integration/backup.integration.test.ts),
which backs up, damages the data, restores, and checks every byte came back.

```bash
npm run backup -- /backups/$(date +%F)          # on the control plane
npm run backup -- verify /backups/2026-10-06    # checksums only
npm run restore -- /backups/2026-10-06 --yes    # destructive: stop the API first
```

| What | How | File |
| ---- | --- | ---- |
| Shipyard's database (projects, settings, encrypted variables, deployments, history, audit log) | `pg_dump -Fc` inside its container | `shipyard.dump` |
| Each project's PostgreSQL service | `pg_dump -Fc` inside the running database: a consistent snapshot, which copying a live data directory is not | `db-<service>.dump` |
| Every other persistent volume | `tar.gz` streamed from a short-lived container that mounts it read-only | `volume-<id>.tar.gz` |
| What and how | `manifest.json`: every file with its size and sha256 | |

- Everything streams through Docker; nothing needs host paths.
- **Not included: `.env`.** Copy it yourself. Without `SHIPYARD_SECRET_KEY`
  the variables in the dump can't be decrypted. Keep backups as secret as
  `.env`: the dumps hold your apps' data.
- Apps and images aren't backed up: they are rebuilt from Git by deploying.
- Volumes and databases on **remote workers** are listed as skipped: run the
  backup on that worker's machine too (`SHIPYARD_DB_CONTAINER` names the
  container holding Shipyard's database, default `shipyard-postgres`).
- Schedule it (cron on the host) and copy the directory off the machine.

### Restore

1. Stop the API (and workers).
2. `npm run restore -- <dir> --yes`: checks the checksums first (a damaged
   backup is refused), then replaces Shipyard's database (`pg_restore --clean`),
   each volume's files, and each database service's contents (a database must
   be deployed and running to be restored into; it is reported otherwise).
3. Put `.env` back, start the API, deploy the projects (images are rebuilt).
4. To try a backup without touching anything: create an empty database and
   `npm run restore -- <dir> --yes --database <that one>` restores Shipyard's
   database into it (the CI test does exactly this).

## Disaster recovery

Shipyard runs on one control plane: there is **no high availability**. If its
machine is lost, recovery is a restore onto a new one.

| | Value | Why |
| - | ----- | --- |
| **RPO** (data you can lose) | the time since the last backup, e.g. 24 h with a nightly backup | backups are periodic snapshots; there is no streaming replication |
| **RTO** (time to recover) | about 30–60 min for a small installation | new machine with Docker, `npm run db:up`, restore, redeploy (builds dominate) |

Strategy: nightly `npm run backup`, copied off site, kept 14 days;
`npm run backup -- verify` after copying; a restore test into a scratch
database monthly (or let the integration test do it on every CI run).
Workers are disposable except for pinned projects' volumes, which their own
backups cover.
