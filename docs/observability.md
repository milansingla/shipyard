# Observability

Code: [`modules/metrics/`](../apps/api/src/modules/metrics/), `containerStats` in
[`DockerService`](../apps/api/src/services/docker/DockerService.ts).

Project page → **Metrics**, or `GET /api/projects/:id/metrics` (VIEWER).

| Number | Where it comes from |
| ------ | ------------------- |
| CPU % | Docker's stats of each replica (100 = one full CPU), summed |
| Memory | in use, page cache excluded, summed over replicas; against the limit if one is set |
| Restarts | Docker's restart count (a crash-looping app under a restart policy) |
| Uptime | since the oldest replica started |
| Running / replicas | replicas running now / asked for |
| CPU, last hour | a sample every 30 s |
| Deploys, last 30 days | production deployments: total, succeeded (reached RUNNING), failed, success rate |
| Typical deploy / build | average start→RUNNING, and average time in BUILDING, of successful ones |

- **Sampling**: every 30 s the control plane asks the worker running each
  RUNNING deployment for its numbers and stores one row per deployment in
  `metric_samples`; rows older than 24 h are dropped. The page asks for fresh
  numbers too, falling back to the last sample if the worker doesn't answer.
- Production only; development and preview environments aren't charted.
- Runtime logs: the deployment page's **Runtime** log (live, Server-Sent Events).
- Shipyard's own logs: JSON lines on stdout (pino), every request with an id.

Alerts built on these numbers: [operations.md](operations.md).

**Limits**: one day of history; no per-replica breakdown in the dashboard;
no network or disk I/O numbers.
