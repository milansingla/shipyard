# The `shipyard` CLI

Code: [`apps/cli/`](../apps/cli/) — no dependencies beyond Node.

The CLI is a thin client of the HTTP API: every command is one or two API
calls (under `/api/v1`), authenticated with an API key. It has **no deployment logic of its
own**, so it can't drift from what the dashboard does, and it gets the same
permissions as its key's owner (team roles, rate limits, audit log).

| Command | Calls |
| ------- | ----- |
| `login --url <dashboard> [--token shp_…]` | `GET /api/auth/me` to check the key, then saves `~/.shipyard/cli.json` (mode 0600). Without `--token`, reads the key from stdin. |
| `logout` | forgets the saved key (revoke it in the dashboard to disable it) |
| `projects` | `GET /api/projects` |
| `status <project>` | `GET /api/projects/:id/deployments` |
| `deploy <project> [--no-follow]` | `POST …/deploy`, then streams `…/logs/stream?type=build` (SSE); exit 0 when RUNNING, 1 when FAILED |
| `logs <project> [--build] [--follow] [--tail n]` | the live (or latest) deployment's logs, streamed with `--follow` |
| `rollback <project>` | `POST /api/deployments/:id/rollback` on the live deployment |
| `env <project> [list \| set K=V [--secret] [--build\|--both] \| unset K]` | `/api/projects/:id/env` |
| `domains <project> [list \| add <hostname> \| remove <hostname>]` | `/api/projects/:id/domains` |
| `ask "<question>"` | `POST /api/ai/ask`: prints the [assistant](ai.md)'s answer and the API calls it suggests; it never runs them |

`<project>` is a name, slug or id. Errors print the API's own message and
exit 1. `SHIPYARD_URL` + `SHIPYARD_TOKEN` override the saved login (CI).

Tested end to end in `api.integration.test.ts`: the real CLI against the real
API and database, from `login` to `rollback`, including a revoked key.
