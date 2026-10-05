# Cron jobs

Code: [`lib/cron.ts`](../apps/api/src/lib/cron.ts) (schedules),
[`modules/cron/CronService.ts`](../apps/api/src/modules/cron/CronService.ts) (scheduler, runs),
`runToCompletion` in [`DockerService`](../apps/api/src/services/docker/DockerService.ts).

A cron job runs a command on a schedule, e.g. a nightly cleanup:

```
cleanup   0 3 * * *   npm run cleanup        (in web's image)
   │
   ▼ 03:00 UTC
 docker run --rm-ish  <web's live image>  sh -c "npm run cleanup"
   env: web's runtime variables (DATABASE_URL, secrets…)
   network: the project's, so db:5432 and http://api:4000 resolve
   → exit code + last 64 KB of output recorded, container removed
```

## Adding one

Project page → **Cron jobs** → **Add a cron job**, or

```bash
curl -X POST …/api/projects/<id>/cron-jobs \
  -d '{"name": "cleanup", "serviceId": "<web>", "schedule": "0 3 * * *", "command": "npm run cleanup"}'
```

or in [shipyard.yaml](configuration.md):

```yaml
cron:
  cleanup:
    schedule: "0 3 * * *"
    command: npm run cleanup
    service: web            # default: "web", else the first service
    timeoutSeconds: 600     # default 3600; 10 s – 24 h
```

| Endpoint | Who |
| -------- | --- |
| `GET /api/projects/:id/cron-jobs` · `GET /api/cron-jobs/:id/runs` · `GET /api/cron-runs/:id` (with output) | VIEWER |
| `POST /api/cron-jobs/:id/run` (run now, 202) | DEVELOPER |
| `POST /api/projects/:id/cron-jobs` · `PATCH`/`DELETE /api/cron-jobs/:id` (`enabled: false` pauses) | ADMIN |

## Schedules

Five fields, **UTC**: minute, hour, day of month, month, day of week.
`*`, numbers, ranges `1-5`, steps `*/15` and `0-30/10`, lists `1,15`, names
`JAN`/`MON`, `7` = Sunday, and `@hourly`, `@daily`, `@weekly`, `@monthly`,
`@yearly`. When both day fields are restricted, a day matches if either does
(`0 0 13 * FRI` = every 13th and every Friday), like standard cron.

## How a run works

- **What it runs**: the image of the service's current RUNNING deployment, no
  rebuild, with that service's runtime variables and resource limits, on the
  project network. Nothing is published.
- **Recorded**: status (`RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`,
  `SKIPPED`), trigger (schedule or by hand), times, exit code, the deployment
  whose image it used, and the last 64 KB of output. The last 50 runs per job
  are kept.
- **Never overlapping**: if the previous run is still going, the new one is
  recorded as SKIPPED.
- **Nothing deployed**: SKIPPED, saying to deploy the service first.
- **Timeout**: killed after `timeoutSeconds` (default 1 hour) → TIMED_OUT.

## The scheduler

Every 15 seconds Shipyard looks for jobs whose `nextRunAt` has passed. Each
job is **claimed** with a conditional update (`… WHERE id = ? AND nextRunAt =
<the value it read>`), which also sets the next occurrence. Only one claim can
succeed, so an occurrence runs once even if two ticks (or two Shipyard
processes) see it at the same time.

- **Missed while Shipyard was down**: the next occurrence is computed from
  *now*, so a backlog runs **once**, not once per missed occurrence.
- **Restart mid-run**: at startup, runs still marked RUNNING are marked
  FAILED ("Interrupted: Shipyard restarted while it ran") and their
  containers removed.
- At most 4 runs at once across all projects; due jobs beyond that wait for
  the next tick.

## Limits

- Schedules are UTC only; no time zones.
- Output is the last 64 KB, saved when the run ends (not streamed live).
- A job runs the image as deployed: code changes need a deploy first.
- Up to 20 jobs per project, about a minute of precision (15 s ticks).
