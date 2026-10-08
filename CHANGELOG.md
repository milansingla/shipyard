# Changelog

All notable changes to Shipyard. Versions follow [Semantic Versioning](https://semver.org/).

## [5.0.0] — 2026-10-08

A self-hosted platform across machines: a control plane and workers, plus
operations, governance and an advisory AI assistant.

### Platform
- **Workers**: machines join with a token, send heartbeats, can be drained, and run deployments remotely through a long-poll RPC channel.
- **Deploy queue in PostgreSQL** (`FOR UPDATE SKIP LOCKED`): priorities, FIFO per project, 60-second leases with renewal, recovery of lost workers, and scheduling by capacity and affinity.
- **Metrics** (CPU, memory, restarts, uptime), and **alerts** to webhooks and Slack.
- **Backups and tested restores** of Shipyard's database, PostgreSQL services and volumes, plus hourly cleanup.
- **Governance**: teams with per-project grants, service accounts, scoped API keys (`read` / `deploy` / `write`), organization policies (resource caps, health checks, allowed domains), production deploy approval, a searchable audit log, and the versioned `/api/v1`.
- **AI assistant** for deployment diagnosis, incident summaries, repository analysis, Dockerfile help, and questions with proposed actions. Read-only, and limited to what the user can already see.

### Deployments
- **Repository detection for any common stack**: Node.js (npm, pnpm, yarn, bun, workspaces, Turborepo), Next.js, Nuxt, SvelteKit, Astro, NestJS, Vite/React/Vue/Angular static sites, Python (FastAPI, Flask, Django, Streamlit), PHP/Laravel, Go, Java (Spring Boot), Rust and plain HTML. Monorepos are searched for the one deployable app.
- **Package managers matched to the repository**: version taken from `packageManager` or inferred from the lockfile format (never "latest"); lockfiles checked against `package.json` before Docker runs; frozen installs that are never relaxed; Node version from `.nvmrc`, `.node-version`, `.tool-versions` or `engines.node`.
- **Failed installs explained**: "Dependency installation failed: the lockfile is out of date…" with the cause, the fix and the package manager's own error lines, instead of `returned a non-zero code: 1`.
- **Resilient package-manager downloads**: retried with backoff; a registry outage is reported as a network problem, not a code problem.
- **Free public links**: one click gives a live app a public `https://….trycloudflare.com` address through a Cloudflare quick tunnel to Traefik. It survives redeploys and rollbacks, is admin-only and audited, and needs no domain or router setup.

### Dashboard
- Redesigned in a black, liquid-glass style: icon sidebar, hero cards with fleet statistics and a pipeline illustration, Geist typography, a sailboat logo and smooth motion with reduced-motion support. Every page works on phones without sideways scrolling.

## [4.0.0] — 2026-10-06

A developer platform.

- API keys (hashed, shown once) and the `shipyard` CLI.
- Audit log; organizations with OWNER / ADMIN / DEVELOPER / VIEWER roles.
- Build cache (dependency installs reused) and an image registry abstraction.
- Multi-service projects with private networking, declared in the dashboard or in `shipyard.yaml`.
- Persistent volumes and self-hosted PostgreSQL services.
- Replicas and rolling deployments, load-balanced by Traefik.
- Cron jobs with recorded runs.
- Development environments, per-environment variables, and pull-request preview deployments.

## [3.0.0] — 2026-10-05

A production deployment platform.

- Deployment state machine: QUEUED → CLONING → DETECTING → BUILDING → STARTING → HEALTH_CHECKING → HEALTHY → ROUTING → RUNNING, with the failure stage recorded.
- Encrypted environment variables and secrets (runtime / build; never shown again, never baked into images).
- Health checks, CPU/memory limits and restart policy per project.
- Deployment history (who, every status, why), one-click rollback, and live build and runtime logs over Server-Sent Events.
- Custom domains with HTTPS through Let's Encrypt; rate limiting.

## [2.0.0] — 2026-10-05

The first complete version.

- TypeScript monorepo: Express API, Next.js dashboard, deployment engine.
- PostgreSQL with Prisma, REST deployment API, deployment history.
- Node.js project detection and Dockerfile generation.
- GitHub OAuth sign-in, repository and branch selection, push-to-deploy webhooks.
- Traefik routing at `http://<project>.localhost` with zero-downtime redeploys.

[5.0.0]: https://github.com/milansingla/shipyard/releases/tag/v5.0.0
[3.0.0]: https://github.com/milansingla/shipyard/releases/tag/v3.0.0
[2.0.0]: https://github.com/milansingla/shipyard/releases/tag/v2.0.0
