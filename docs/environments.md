# Environments

Code: [`modules/environments/`](../apps/api/src/modules/environments/),
environment handling in [`DeploymentService`](../apps/api/src/modules/deployments/DeploymentService.ts),
variable rules in [`EnvironmentService.forDeployment`](../apps/api/src/modules/environment/EnvironmentService.ts).

| Environment | What | Address | Deploys |
| ----------- | ---- | ------- | ------- |
| **Production** | the project itself | `shop.<domain>`, custom domains | the project's branch |
| **Development** | one per project, another branch | `dev-shop.<domain>` | pushes to its branch, **Deploy** |
| **Preview** | one per pull request | `pr-12-shop.<domain>` | the pull request (see below) |

Secondary public services follow the same pattern: `dev-admin-shop`, `pr-12-admin-shop`.

## What an environment runs

Development and preview environments run the project's **web services and
workers**, built from their own branch. They do **not** get:

- **databases**: a PostgreSQL service is production's. A development
  environment reaches it through `DATABASE_URL` like production does (set a
  `DATABASE_URL` for Development to point it elsewhere); previews don't get
  that URL at all (see secrets below);
- **volumes**: production's data is never mounted elsewhere;
- **custom domains**, **replicas** (always one), **cron jobs**;
- **shipyard.yaml changes**: an environment uses the project's service
  definitions; a branch's shipyard.yaml takes effect when it is deployed to
  production.

Each environment has its own deploy lock, so a development deploy never
blocks a production one. Deployments, rollback and restart work per
environment: rolling back dev never touches production.

**Closing** an environment (**Close**, `POST /api/environments/:id/close`)
stops it and removes its containers and images; its deployments stay in the
history. A closed development environment can be opened again with a branch.

## Variables per environment

Every variable applies to **All** environments, or to one (**Production**,
**Previews**, **Development**): `PUT /api/projects/:id/env/KEY?environment=PREVIEW`.
A value for one environment overrides the shared value there, and a service's
own value overrides the project's:

```
project, All  <  project, this environment  <  service, All  <  service, this environment
```

**A secret set for All is a production secret: previews never get it.** A
preview builds code from a pull request, which may come from a teammate's
experiment; it gets only the secrets explicitly set for **Previews** (a test
Stripe key, a staging database URL). Non-secret values for All reach every
environment. Each value is encrypted bound to its environment too, so a
production ciphertext copied into a preview row doesn't decrypt.

## API

| Endpoint | Who |
| -------- | --- |
| `GET /api/projects/:id/environments` | VIEWER |
| `POST /api/projects/:id/environments {"type": "DEVELOPMENT", "branch": "develop"}` · `PATCH /api/environments/:id {"branch"}` · `POST /api/environments/:id/close` | ADMIN |
| `POST /api/environments/:id/deploy` | DEVELOPER |

Project and service names starting with `dev-` or `pr-<number>-` (and services
named `dev` or `pr-<number>`) are refused: those addresses belong to environments.
