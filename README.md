# Shipyard 🚢

A small, understandable, self-hosted deployment platform — think a tiny
Render/Railway you can read end to end.

```
GitHub repo → clone → detect → docker build → container → health check → URL
```

> **Status: V2, Milestone 1 — TypeScript foundation.**
> The V0.1 engine (clone → build → run → logs → stop → restart) has been
> ported to TypeScript with explicit deployment states, real health checks and
> tests. Database, GitHub OAuth, webhooks, Traefik and the dashboard are next.
> See [the roadmap](#roadmap).

## Requirements

| Tool           | Version | Check                     |
| -------------- | ------- | ------------------------- |
| Node.js        | ≥ 22.12 | `node -v`                 |
| npm            | ≥ 10    | `npm -v`                  |
| Docker Desktop | running | `docker version`          |
| git            | any     | `git --version`           |

## Setup

```bash
npm install
cp .env.example .env      # optional — every variable has a safe default
```

## Deploy something (CLI)

```bash
# Any public GitHub repo with a Dockerfile at its root
npm run shipyard -- deploy https://github.com/<owner>/<repo>
npm run shipyard -- deploy https://github.com/<owner>/<repo> --branch develop

# Manage it using the container name printed by deploy
npm run shipyard -- logs    shipyard-<repo>-<id> [--tail 100]
npm run shipyard -- restart shipyard-<repo>-<id>
npm run shipyard -- stop    shipyard-<repo>-<id>
```

A sample app lives in [`examples/hello-node`](examples/hello-node) — push it to
a GitHub repo of your own to try a full deployment.

**Your app must** listen on `0.0.0.0` and on the port in `$PORT` (Shipyard sets
it to the Dockerfile's `EXPOSE` port, or 3000 when there is none).

## Run the API

```bash
npm run dev:api                       # http://localhost:4000, auto-reload
curl http://localhost:4000/api/health # {"data":{"status":"ok","docker":"reachable"}}
```

## Tests

```bash
npm test                  # unit tests — fast, no Docker or network needed
npm run test:integration  # real Docker builds + real GitHub clone (Docker must be running)
npm run typecheck
```

## Repository layout

```
apps/api/            Express API + CLI + deployment engine (TypeScript)
  src/services/      git, docker, detection, deployment, workspace
  test/unit/         fast tests
  test/integration/  real Docker / network tests
examples/hello-node/ sample deployable app
docs/                architecture, engine, security, learning notes
phase-1/             the original V0.1 JavaScript prototype (kept for reference)
```

## Documentation

- [Architecture](docs/architecture.md) — components and why they are split this way
- [Deployment engine](docs/deployment-engine.md) — pipeline, statuses, health checks, debugging
- [Security](docs/security.md) — threat model and what is (not yet) safe
- [Learning notes](docs/learning-notes.md) — concepts + interview prep per milestone

## Roadmap

- [x] **M1** TypeScript foundation, status model, health checks, tests
- [ ] **M2** PostgreSQL + Prisma, REST deployment API, deployment history
- [ ] **M3** Node.js project detection + Dockerfile generation
- [ ] **M4** GitHub OAuth, repository & branch selection
- [ ] **M5** Next.js dashboard
- [ ] **M6** GitHub webhooks (auto-deploy on push)
- [ ] **M7** Traefik routing, zero-downtime redeploy
