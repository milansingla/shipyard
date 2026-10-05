# Routing & zero-downtime redeploys

Code: [`services/routing/`](../apps/api/src/services/routing/) (the routers),
step 6 of [`DeploymentEngine.run`](../apps/api/src/services/deployment/DeploymentEngine.ts),
and [`DeploymentService`](../apps/api/src/modules/deployments/DeploymentService.ts)
(retiring, stopping, startup sync).

With `SHIPYARD_PUBLIC_DOMAIN=localhost`, every project has one stable address,
`http://<project-slug>.localhost`, and keeps it across deployments. A redeploy
moves that address to the new version only once the new version is healthy;
visitors never see an error while that happens.

```
 Browser ── http://shop.localhost ──► Traefik (127.0.0.1:80) ──┐ network "shipyard-edge"
                                       reads routes.yml        ├──► shipyard-shop-9f2c…:3000  (live)
                                                               └ ✗ shipyard-shop-41ab…:3000  (retired, stopped)
 Shipyard API ── writes ~/.shipyard/traefik/routes.yml
              └─ health checks via 127.0.0.1:<published port>
```

Without `SHIPYARD_PUBLIC_DOMAIN`, nothing changes from earlier milestones: each
deployment is reached on its own published port (`http://localhost:49153`),
and its URL changes with every deploy.

## Setup

```bash
# .env
SHIPYARD_PUBLIC_DOMAIN=localhost
# SHIPYARD_HTTP_PORT=8000   # only if port 80 is taken; URLs become http://<slug>.localhost:8000

npm run db:up       # starts PostgreSQL AND Traefik (docker-compose.yml)
npm run dev:api     # restart the API so it reads the new variable
```

`*.localhost` needs no DNS setup: browsers, curl and Node resolve every
`something.localhost` to 127.0.0.1. Deployments that were running before
routing was switched on are attached to Traefik's network and get their new URL
when the API starts.

## What Traefik is, and why

Traefik is a reverse proxy: one process that receives every HTTP request for
the apps and forwards each to the right container, chosen by the `Host`
header. It reloads its routing table at runtime, without dropping connections.

| Considered | Why not (for V2) |
| ---------- | ---------------- |
| Keep published ports | A new URL on every deploy; nothing can switch traffic between versions |
| Traefik **Docker provider** (container labels) | Traefik would need the Docker socket, which is root on the host. It also routes to a container as soon as it starts, before Shipyard's health check passes |
| nginx | Reloading means rewriting config + `nginx -s reload` through Docker; no file watching |
| Caddy (admin API) | A good fit too; Traefik was the V2 plan and its file provider needs no extra API to secure |
| Traefik REST/API provider | More moving parts than writing one file |

Traefik's **file provider** gives Shipyard full control over *when* traffic
moves, and Traefik never touches Docker.

## How it works

### The route table is one file, derived from the database

`TraefikRouter` keeps one route per project (`slug → deployment`) and writes the
whole table to `<SHIPYARD_DATA_DIR>/traefik/routes.yml` on every change. It
writes a temporary file, then renames it over the old one, so Traefik never
reads a half-written file. docker-compose.yml mounts that directory read-only
into Traefik, which reloads when it changes.

The file is JSON, which is also valid YAML, so there are no quoting rules to
get wrong. For each project it holds:

- a **router**: ``Host(`shop.localhost`)`` → service `shipyard-shop`;
- a **service**: `http://<container name>:<container port>`, reached over the
  `shipyard-edge` Docker network (Docker's DNS resolves container names);
- a **middleware** adding `X-Shipyard-Deployment: <deployment id>` to every
  response, so anyone, including Shipyard, can see which deployment answered.

The database is the source of truth. At startup, `reconcileOnStartup()`
rebuilds the table from the RUNNING deployments, which also removes routes for
projects deleted while Shipyard was down.

### The cutover (redeploy)

```
new container STARTING ── health check via 127.0.0.1:<published port>
        │
     HEALTHY ── old deployment still RUNNING and serving
        │   router.activate(): write routes.yml pointing at the new container,
        │   then ask Traefik for shop.localhost until the response says
        │   X-Shipyard-Deployment: <new id>   (Traefik applies at most one change every ~2s)
     RUNNING ── traffic has really moved
        │
retire old: take it out of the router (no-op, the route moved on) → docker stop (SIGTERM, 10s grace)
```

The old container is stopped only after Traefik has *proven* it sends traffic
to the new one, so no request goes to a stopping container. A fixed sleep
would not be enough: Traefik's reload delay varies.

### When something fails

| What failed | Result |
| ----------- | ------ |
| Build, start or health check | FAILED; the route never changed, the old deployment keeps serving |
| Traefik doesn't confirm within 15s (not running, misconfigured) | `ROUTING_FAILED`; the previous route is written back, the new container stopped, the old deployment keeps serving |
| Shipyard crashes mid-cutover | At startup the half-finished deployment is marked FAILED and the table is rebuilt from what is RUNNING |

### Stop, rollback, delete

- **Stop** the live deployment: its route is removed first (visitors get
  Traefik's 404), then the container stops. Removing a route only happens if
  it still points at that deployment, so retiring an old one never takes the
  hostname away from the new one.
- **Rollback**: `POST /api/deployments/:id/rollback` (the **Roll back**
  button) brings back the newest earlier deployment that ran successfully
  and still has its container. Or restart a specific older, STOPPED
  deployment. It is health-checked,
  takes over the hostname the same way, and then the current one is retired.
  This is zero-downtime too.
- **Restart** of the *live* deployment is not zero-downtime: it is the same
  container being restarted. Redeploy instead to replace it without a gap.
- **Delete project**: its route is removed with its containers.

## Custom domains

Project page → **Domains**, or `POST /api/projects/:id/domains {"hostname": "app.example.com"}`.

- The hostname is added to the project's router rule
  (``Host(`shop.localhost`) || Host(`app.example.com`)``) and goes live on the
  running deployment within seconds. No redeploy is needed, since routing
  isn't part of the container. Every later deployment, restart, rollback and
  startup sync carries it.
- One hostname belongs to one project (409 `DOMAIN_TAKEN`, without saying
  whose). Addresses under `SHIPYARD_PUBLIC_DOMAIN` can't be claimed: they're
  the generated ones. Validation: lower-cased DNS names with at least two
  labels; no IPs, ports, schemes or wildcards; at most 20 per project.
- **DNS is yours to set**: point an A/AAAA (or CNAME) record at this server.
  Locally, try it with `curl -H 'Host: app.example.com' http://127.0.0.1/`.

## HTTPS in production (Let's Encrypt)

```bash
# .env
SHIPYARD_PUBLIC_DOMAIN=apps.example.com   # DNS: *.apps.example.com → this server
SHIPYARD_ACME_EMAIL=you@example.com

docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --wait
```

[`docker-compose.production.yml`](../docker-compose.production.yml) publishes
ports 80 and 443 on all interfaces, redirects HTTP to HTTPS, and defines a
Let's Encrypt resolver using the HTTP-01 challenge. Certificates are kept in a
named volume. With `SHIPYARD_ACME_EMAIL` set, Shipyard writes every router on
the `websecure` entry point with `tls.certResolver: letsencrypt`: each
generated and custom hostname gets its own certificate on first use. URLs
become `https://…`, and the cutover probe talks HTTPS to Traefik (SNI set,
certificate not verified: it is a loopback check of the routing header, and a
fresh hostname's certificate may still be being issued).

This path is validated by config generation tests and by starting Traefik
with these flags; issuing real certificates needs a public server and DNS, so
it can't run in the local test suite.

## Why containers still publish a port

Each deployment container still publishes its port on **127.0.0.1** (never
`0.0.0.0` with routing on; config validation enforces it). That port is how
the Shipyard API, which runs on the host, health-checks a new container before
it gets any traffic. On macOS, Docker Desktop's container IPs aren't reachable
from the host, so the published port is the only portable way in. Visitors use
the hostname.

## Debugging

```bash
docker ps --filter name=shipyard-traefik           # 1. Is Traefik running? (npm run db:up)
cat ~/.shipyard/traefik/routes.yml                 # 2. What does Shipyard want routed?
curl -sI -H 'Host: shop.localhost' http://127.0.0.1/   # 3. What does Traefik serve? Check X-Shipyard-Deployment
docker logs shipyard-traefik                       # 4. Config errors, unreachable backends
docker network inspect shipyard-edge --format '{{range .Containers}}{{.Name}} {{end}}'   # 5. On the network?
curl -v http://127.0.0.1:<hostPort>/               # 6. Does the app itself answer?
```

| Symptom | Likely cause |
| ------- | ------------ |
| `ROUTING_FAILED … ECONNREFUSED` | Traefik not running: `npm run db:up` |
| `ROUTING_FAILED … Traefik has no route for it yet` | Traefik reads a different directory: `SHIPYARD_DATA_DIR` must be absolute and the same for the API and docker-compose (both read `.env`) |
| `Docker network "shipyard-edge" doesn't exist` | Traefik was never started: `npm run db:up` |
| 404 from Traefik | No RUNNING deployment for that hostname, or a typo in the slug |
| 502 Bad Gateway | Container stopped behind Traefik's back (`docker stop`); restart or redeploy it |
| `docker compose up` fails: port 80 in use | Set `SHIPYARD_HTTP_PORT=8000` (or another free port) in `.env` |

## Security

- **Traefik has no Docker socket.** With the Docker provider, a Traefik bug
  would be root on the host. Here it can only read one directory, mounted
  read-only.
- **Only Shipyard writes routes**, and every value in them is validated: slugs
  and container names must be DNS labels, ports in range, deployment ids
  `[A-Za-z0-9-]`. Repository content never reaches the file.
- **Loopback by default**: in development Traefik listens on `127.0.0.1`.
  Only the production override opens 80/443 to the network, and then with
  HTTPS and an HTTP→HTTPS redirect.
- **Alias headers are dropped** (`aliasHeadersStrategy=delete`): a client can't
  send `X_Forwarded_For` to impersonate a header Traefik sets, for backends
  that treat `_` like `-`.
- `X-Shipyard-Deployment` reveals the deployment id. It is not a secret, since
  ids only work for their owner's session, but it does show visitors when you
  deploy.
- **Known gap**: every deployment shares the `shipyard-edge` network, so apps
  can reach each other by container name. They could on the default bridge
  network before, too, by IP. Per-project networks are a later item.

## Limits

- HTTPS needs a publicly reachable server (HTTP-01 challenge); wildcard
  certificates (DNS-01) are not set up.
- Custom domains aren't verified as yours: on a server only trusted people
  can sign in to, unique ownership per hostname is the guard. A domain does
  nothing until its DNS points here.
- Load balancing is round robin across a deployment's replicas (see
  [services.md](services.md#replicas-and-rolling-deployments)); no sticky sessions.
- Request-level zero downtime depends on the app finishing in-flight requests
  on SIGTERM within 10s, which most HTTP servers do (see `examples/hello-node`).
- One Shipyard process: the route table's lock is in memory, like the deploy lock.
