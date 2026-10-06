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
