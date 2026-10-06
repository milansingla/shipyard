# Access control (RBAC)

Code: [`AccessService`](../apps/api/src/modules/access/AccessService.ts) (every decision),
[`TeamService`](../apps/api/src/modules/access/TeamService.ts),
[`ServiceAccountService`](../apps/api/src/modules/access/ServiceAccountService.ts),
[`apiKeyScopes`](../apps/api/src/middleware/apiKeyScopes.ts).

```
Organization
├── Members        a role each: OWNER > ADMIN > DEVELOPER > VIEWER
├── Teams          groups of members, granted a role on chosen projects
├── Service accounts   non-human members (CI, scripts): API keys only
└── Projects
```

## Who may do what

| Permission | Role needed |
| ---------- | ----------- |
| project.read: projects, deployments, logs, metrics, history | VIEWER |
| environment.read: variable values (secrets: never) | DEVELOPER |
| deployment.create / deployment.rollback / restart / stop / cancel, environment.write, cron run | DEVELOPER |
| project.write: settings, services, volumes, databases, cron jobs, environments, domain.manage | ADMIN |
| team.manage (teams, members up to DEVELOPER, service accounts, alert channels) | ADMIN |
| members' ADMIN/OWNER roles, deleting the organization | OWNER |
| workers, platform alerts and channels | platform admin (`SHIPYARD_ADMINS`) |

Enforced in the API, on every request (the dashboard only hides what you
can't do). Not a member of a project's organization → **404**, so other
organizations' ids can't be probed; a member with too low a role → **403**
saying which role is needed.

## Teams

A team grants its members a role (VIEWER, DEVELOPER or ADMIN, never OWNER)
on specific projects of its organization. A member's role on a project is the
**higher** of their organization role and their teams' grants: e.g. everyone
is VIEWER, and the `frontend` team is DEVELOPER on the web projects only.
Only members of the organization can join its teams.

`GET/POST /api/organizations/:id/teams`, `DELETE /api/teams/:id`,
`POST /api/teams/:id/members {login}`, `DELETE /api/teams/:id/members/:userId`,
`PUT /api/teams/:id/projects/:projectId {role}`, `DELETE …/projects/:projectId`.

## Service accounts

An automation identity of one organization: a member with a fixed role
(never OWNER), shown as `<name>[bot]`. It has no GitHub account, can't sign
in, and acts only through API keys that the organization's ADMINs create
(from the dashboard: a key can't mint keys). Deleting it revokes its keys
at once. The sign-in allowlist (`SHIPYARD_ALLOWED_GITHUB_USERS`) is about
people and doesn't apply to it.

`GET/POST /api/organizations/:id/service-accounts {name, role}`,
`DELETE /api/service-accounts/:id`,
`POST /api/service-accounts/:id/keys {name, scopes, expiresInDays}`,
`DELETE /api/service-accounts/:id/keys/:keyId`.

## API key scopes

A key (a person's or a service account's) can be limited further:

| Scopes | May |
| ------ | --- |
| none, or `write` | everything its owner's role allows |
| `deploy` | read, and deploy, roll back, restart, stop, cancel, run cron jobs |
| `read` | read only (GET) |

A key never exceeds its owner's role; scopes only take away. For CI, give a
service account with DEVELOPER a `deploy` key: a leaked key can redeploy,
not change settings, variables or domains, or delete anything.
