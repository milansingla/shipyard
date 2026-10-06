# Workers

Code: [`modules/workers/`](../apps/api/src/modules/workers/).

A **worker** is a machine that runs deployments with its own Docker. The
control plane (the API) is one itself, its **built-in worker**, so a single
server needs nothing extra. Other machines join with a token.

```
            Control plane (API, database, scheduler)
                 │  built-in worker: this machine's Docker
     register / heartbeat (HTTPS, worker secret)
        ┌────────┴────────┐
     builder-1         builder-2
      Docker             Docker
```

## Registry

| Step | How |
| ---- | --- |
| Register | `POST /api/workers/register` with `Authorization: Bearer <SHIPYARD_WORKER_JOIN_TOKEN>` and `{name, hostname, cpus, memoryMb, version}`. Returns the worker and **its own secret** `shpw_…`, once. Re-registering the same name replaces the secret. |
| Heartbeat | `POST /api/workers/:id/heartbeat` with `Bearer shpw_…` and `{runningJobs}`, every 10 s |
| Disconnect | `POST /api/workers/:id/disconnect` on clean shutdown |
| Offline | no heartbeat for 45 s → `OFFLINE` (checked every 10 s); the next heartbeat brings it back `ONLINE` |
| Drain | platform admins: `POST /api/workers/:id/drain` → `DRAINING`: no new work, running work continues; `…/undrain` |
| List | platform admins: `GET /api/workers` |

Statuses: `ONLINE` (gets work), `DRAINING` (finishes, gets nothing new; kept
through heartbeats and restarts), `OFFLINE`.

## Security

- **The join token admits machines**: set `SHIPYARD_WORKER_JOIN_TOKEN` (≥ 32
  characters) only when you add workers. It is compared in constant time; the
  register endpoint is rate limited per IP. Unset: registration answers 503.
- **Each worker has its own secret**, stored as a sha256 hash and shown once,
  so one worker can't act as another, and replacing it (re-register) revokes
  the old one. User sessions and API keys are not worker secrets, and worker
  secrets are not user credentials.
- **Platform admins** are `SHIPYARD_ADMINS` (GitHub logins), separate from
  organization roles: workers serve every tenant.
- A worker runs untrusted repository code with Docker, which is root on that
  machine (see [security.md](security.md)): treat worker machines like the
  control plane.
