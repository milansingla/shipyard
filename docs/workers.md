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

## The deploy queue

Code: the queue section of [`DeploymentService`](../apps/api/src/modules/deployments/DeploymentService.ts),
[`scheduler.ts`](../apps/api/src/modules/deployments/scheduler.ts).

`POST /deploy` (and pushes, previews, retries) records the deployments **and a
job** (`deploy_jobs`) in one transaction and answers 202. Workers run jobs:

```
QUEUED ──claim (lease 60 s)──► RUNNING ──► SUCCEEDED | FAILED
  │                              │ lease not renewed (worker lost)
  └─ cancel ──► CANCELLED        └──► FAILED (WORKER_LOST) ──► retried as a new job, if safe
```

- **Claiming** is one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`:
  several workers claim at once without blocking each other, and each job
  is claimed once.
- **One job per project environment at a time**: a partial unique index on
  `lockKey WHERE status = 'RUNNING'` makes the database refuse a second one,
  whichever worker or process tries. Within an environment jobs run in the
  order they were requested; across environments, manual deploys (priority
  10) go before pushes (0).
- **Pushes are coalesced**: a push arriving while a push deploy of the same
  environment is still queued rides along with it (it builds the branch's
  latest commit anyway).
- **Scheduler**: a worker takes jobs only while it is `ONLINE`, accepts jobs,
  and has a free slot (2 jobs at once). Among eligible workers the one with
  the most free slots wins, then the most memory, then CPUs. `DRAINING` and
  `OFFLINE` workers get nothing.
- **Leases**: a running job's lease (60 s) is renewed every 20 s by its
  worker. A job whose lease expired lost its worker: its unfinished
  deployments become FAILED with `WORKER_LOST`. If none of them had started a
  container, nothing can be running twice, so the job is retried as a new job
  (at most 3 attempts in all); otherwise a person decides (redeploy or roll
  back).
- **Cancel**: `POST /api/deployments/:id/cancel` while its job is still queued.
- **Restarts of Shipyard**: queued jobs survive; jobs this worker was running
  are marked interrupted, and their deployments FAILED.
- Restarts, rollbacks and closing an environment are refused (409) while a
  deploy job of that environment runs.

## Remote workers

Code: [`worker/agent.ts`](../apps/api/src/worker/agent.ts) (the worker),
[`WorkerCalls`](../apps/api/src/modules/workers/WorkerCalls.ts) and
[`RemoteEngine`](../apps/api/src/modules/workers/RemoteEngine.ts) (the control plane's side).

The control plane keeps orchestration (queue, scheduler, database, routing);
a worker performs the engine's operations on its own Docker: clone, build,
start, health check, stop, restart, logs, cron runs, cleanup.

```
control plane                                  worker (npm run worker)
  DeploymentService ──RemoteEngine.run(job)──►  worker_calls (in memory)
                                   ◄── POST /api/workers/:id/calls/next   (long poll, 25 s)
                                   ◄── …/calls/:callId/events             status, log lines, "route this"
  Traefik ◄── route: http://<worker address>:<published port>
                                   ◄── …/calls/:callId/complete           result, or {code, message}
```

### Running one

On a machine with Docker and git:

```bash
SHIPYARD_CONTROL_PLANE_URL=https://shipyard.example.com   # the API
SHIPYARD_WORKER_JOIN_TOKEN=<same as the control plane's>
SHIPYARD_WORKER_NAME=builder-1
SHIPYARD_WORKER_ADDRESS=10.0.0.5     # where Traefik reaches this machine
SHIPYARD_PUBLISH_HOST=0.0.0.0        # so it can (firewall it to the control plane!)
npm run worker                       # production: npm run build && npm run start:worker
```

Same image registry settings (`SHIPYARD_REGISTRY…`) on every machine, so a
project can move between workers.

### Rules

- **Calls carry secrets, so they aren't stored**: a deploy's arguments include
  the app's decrypted variables. They stay in the control plane's memory and
  travel to the worker over the call channel (**use HTTPS** between
  machines). The `worker_calls` table records method, status, timing and ids.
- **One worker per project**: a project's services share a private Docker
  network, which exists on one machine, so a project stays on the worker it
  runs on while that worker is ONLINE. A project with volumes (a database's
  data) is **pinned** to the worker holding them: its deploys wait if that
  worker is away. Otherwise a draining or offline worker's projects move on
  their next deploy.
- **A worker that goes away** (missed heartbeats, or a clean disconnect): its
  calls fail at once as `WORKER_LOST`, so its deployments are FAILED with
  that reason instead of hanging.
- **Logs**: build output streams to the control plane and is stored with the
  deployment (which records its `workerId`); live runtime logs are streamed
  from the worker on demand.
- Calls live in the control plane's memory: if it restarts, calls in flight
  fail (and are recorded as interrupted).

### Limits

- One control plane process (calls and the deploy lock for restarts are in its memory).
- Traefik must reach each worker's address; there is no overlay network.
- A pinned project (with volumes) can't move to another worker: its data is
  on that machine. Back it up ([operations.md](operations.md)).
