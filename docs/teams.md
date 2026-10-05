# Teams & roles

Code: [`modules/access/`](../apps/api/src/modules/access/) (`AccessService` makes
every authorization decision; `OrganizationService` manages teams).

Projects belong to an **organization**. Every user has a personal one
(created at their first sign-in; existing users and projects were moved into
theirs by the migration). Create a **team** to share projects, then choose
it when creating a project.

## Roles

| Role | Can |
| ---- | --- |
| `VIEWER` | See projects, deployments, logs, history, activity; variable **names** (values hidden) |
| `DEVELOPER` | + deploy, redeploy, restart, roll back, stop; set and delete variables; create projects in the team |
| `ADMIN` | + project settings, custom domains, delete projects; add/change/remove DEVELOPER and VIEWER members |
| `OWNER` | + grant, change and remove ADMIN and OWNER; there is always at least one OWNER |

Rules the API enforces (the dashboard only hides what you can't use):

- Not a member → **404**: other teams' project and deployment ids can't even be confirmed to exist.
- A member with too low a role → **403** `This needs the DEVELOPER role or higher in Acme; you are VIEWER.`
- The last OWNER can't be demoted or leave (409 `LAST_OWNER`).
- Members are added by GitHub login and must have signed in once (so they are on `SHIPYARD_ALLOWED_GITHUB_USERS`).
- Personal organizations have exactly one member.
- Pushes deploy as Shipyard itself (the webhook's signature is the authority), whoever created the project.
- API keys act as their owner, with the owner's roles.
- The activity log shows everything in your organizations, including deleted projects; membership changes are logged.

## API

| Endpoint | Does |
| -------- | ---- |
| `GET /api/organizations` | your organizations, with your role and member count |
| `POST /api/organizations {name}` | create a team (you are OWNER) |
| `GET /api/organizations/:id/members` | members (any member) |
| `POST /api/organizations/:id/members {login, role}` | add a member (ADMIN+) |
| `PATCH /api/organizations/:id/members/:userId {role}` | change a role |
| `DELETE /api/organizations/:id/members/:userId` | remove a member, or leave |
| `POST /api/projects {…, organizationId}` | create a project in a team (DEVELOPER+) |

Projects in responses carry `organization` and your `role` there.
