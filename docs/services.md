# Services (multi-service projects)

Code: [`modules/services/`](../apps/api/src/modules/services/) and the engine's
`ServiceSpec` ([`services/deployment/types.ts`](../apps/api/src/services/deployment/types.ts)).

A project is one repository; its **services** are the things that run from
it: a frontend, an API, a background worker. Every project starts with one
public web service, `web`, at the repository root. Add more on the project
page (**Services → Add a service**) or with
`POST /api/projects/:id/services`.

| Setting | Meaning |
| ------- | ------- |
| `name` | Lowercase DNS label, ≤ 20 characters. It is also the service's hostname inside the project. |
| `type` | `WEB` serves HTTP (health-checked over HTTP); `WORKER` runs in the background (healthy once it keeps running for 10s; never routed) |
| `sourceDir` | Directory to build, e.g. `apps/api`. Relative, no `..`; checked again against the real files at deploy time, including symlinks pointing out of the repository. |
| `port` | Overrides the detected port (web) |
| `public` | Web services only. Public = gets an address; private = reachable only by the project's other services |
| `startCommand` / `buildCommand` | Override detection; run with `sh -c`. With your own Dockerfile, the start command replaces its `CMD` and the build command is ignored. |
| `healthCheck*`, `cpuLimit`, `memoryLimitMb` | Per-service overrides of the project's settings |

## Addresses

- The **primary** service (the public web service named `web`, else the
  oldest public web service) has the project's address:
  `http://<slug>.<domain>`.
- Other public web services: `http://<service>-<slug>.<domain>`. Shipyard
  refuses to create a project or service whose address would clash with an
  existing one.
- Custom domains point at the primary service, or at a chosen public web
  service (`serviceId`).

## Private networking

Each project has its own Docker network, `shipyard-p-<id>`. Every container
of the project joins it under its service name, so services call each other
as `http://api:4000`. Only public web services also join the router's
network. Workers and private services publish nothing beyond the loopback
health-check port. Services of different projects can't resolve each
other's names.

## Deploying

`POST /api/projects/:id/deploy` (or a push) deploys **every** service at the
branch's latest commit, one deployment per service, in order: private
services and workers first, then other public services, the primary last. A
new frontend therefore never goes live before the backend it calls. Each
service switches with zero downtime on its own. If one fails, it keeps its
previous version and the others still deploy. `POST /api/services/:id/deploy`
deploys a single service. Rollback, restart and history are per service.

## Variables per service

Variables are project-wide by default. `PUT /api/projects/:id/env/KEY?service=<id>`
sets a variable for one service only, overriding a project-wide one with
the same name for that service. Each ciphertext is bound to its project,
scope and key.

## Persistent volumes

A container's files are thrown away with it, at every deploy. A **volume**
keeps a directory across deployments: uploads, an SQLite file, a cache.

Project page → a service → **Add a volume**, or
`POST /api/services/:id/volumes {"name": "uploads", "mountPath": "/app/uploads"}`
(admins), or `volumes:` in [shipyard.yaml](configuration.md). It is mounted
from the next deployment on, into every deployment, rollback and restart of
that service.

| Rule | Why |
| ---- | --- |
| Name: 1–30 lowercase letters, digits, `-`; one per name and per path in a service; at most 10 | |
| Path: absolute, no `.`/`..` segments, not `/` or a system directory (`/etc`, `/usr`, `/proc`, …) | Mounting over the image's own system files breaks it, or hides what it needs |
| Docker volume `shipyard-<service id>-<name>` | The id, not the project slug: slugs are reused after a project is deleted, so a slug-based name could hand one project's leftover data to a new one |
| A new volume is handed to the image's user (`chown`, once, by a short-lived container with no network) | Docker creates volumes owned by root; apps that run as `node` couldn't write to them otherwise. The image needs a `chown` binary (every Alpine/Debian image has one) |

**Removing data is never implied:**

- `DELETE /api/volumes/:id` (**Detach**) only stops mounting it. The data
  stays on the server; adding a volume with the same name to the same service
  brings it back. `docker volume rm <dockerName>` deletes it for good.
- Deleting a service or project that has volumes is refused (409
  `VOLUMES_EXIST`) unless the request says `?deleteData=true`. The dashboard
  asks you to type the name. Then the containers are removed first, then the
  volumes, then the rows.
- Shipyard only ever removes volumes labelled `shipyard.managed`.

Volumes live on this server's disk, inside Docker. There are no snapshots or
backups yet (back up `/var/lib/docker/volumes` or use `docker run --rm -v …
tar`), no size limit, and a volume can't be shared between services: each
service has its own.

## Migration

The `services` migration gave every existing project a `web` service (public,
repository root) and attached all of its deployments to it. It is
hand-written and was run against existing rows before committing.
