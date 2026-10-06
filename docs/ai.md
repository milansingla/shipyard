# AI assistant

An adviser built into Shipyard. It explains failed deployments, summarizes incidents, suggests how to run a repository, drafts Dockerfiles and answers questions about your projects. **It never changes anything itself.**

It is off until the server has an Anthropic API key:

```bash
ANTHROPIC_API_KEY=sk-ant-...
SHIPYARD_AI_MODEL=claude-opus-5-5   # optional; this is the default
```

Without it every assistant endpoint answers `503 AI_NOT_CONFIGURED`; the rest of Shipyard is unaffected. Each request is a paid call to the Claude API (the assistant's questions can take several), limited to 10 per user per minute.

## What it does

| Where | Endpoint | Role needed | What you get |
|---|---|---|---|
| Deployment page → **Explain with the assistant** | `POST /api/ai/deployments/:id/diagnosis` | viewer | Summary, cause and category (build, start, health check, routing, resources, configuration), the log lines it is based on, a suggested fix, confidence, and rollback advice |
| Alerts → **Summarize with the assistant** | `POST /api/ai/alerts/:id/summary` | viewer | What happened, the likely cause and what to do, next to Shipyard's own timeline of the deployments and the alert |
| Project page → **Analyze repository** | `POST /api/ai/projects/:id/analysis` | viewer | Language, framework, package manager, build/start commands, port, health endpoint, Node version, each with the file excerpt that shows it; where it disagrees with Shipyard's own detection |
| Project page → **Suggest a Dockerfile** | `POST /api/ai/projects/:id/dockerfile` | developer | A Dockerfile and explanation, statically checked (below). Not deployed |
| **Assistant** page | `POST /api/ai/ask` `{ "question": "…" }` | any | An answer, plus suggested actions you can run |

All endpoints also work under `/api/v1/ai/…` and with API keys, including read-only keys: asking changes nothing.

## Guarantees

**It sees only what you can see.** Every lookup goes through the same access checks as the API. Ask about a project you have no access to and, to the assistant, it doesn't exist.

**It can't change anything.** For questions it has read-only tools: list projects, project overview, list deployments, deployment details, deployment logs (last 200 lines at most), list alerts. It can't run commands, reach Docker or edit settings. If it thinks you should roll back, redeploy, restart or stop, it calls `propose_action`. Shipyard checks you have at least the developer role on that project, then shows the proposal as a button. Clicking it (after a confirmation) calls the normal endpoint with your session, so RBAC, organization policies, approvals, rate limits and the audit log all apply as they do for any click.

**No secrets reach the model.** It gets variable *names* (marked `(secret)` when they are), never values. If an app prints a secret, the value is replaced with `[secret]` in logs, errors and tool results before anything is sent (values under 4 characters aren't masked).

**Evidence is checked.** Every excerpt the model cites must appear in the real logs or files (ignoring whitespace). Ones that don't are dropped; the response says how many (`droppedEvidence`), and the confidence goes down. A diagnosis with no backing log lines is shown as a guess.

**Shipyard decides the facts that matter.** Rollback advice is computed, not generated: a failed deploy whose previous version kept serving needs no rollback; otherwise Shipyard names the last deployment that ran successfully, the one a rollback would actually restore. Incident timelines come from Shipyard's own records. Repository analysis is advice: the build still uses Shipyard's own detection and your settings.

**Model output is data.** Logs and repository files are written by apps and their authors, so the model is told to treat them as data, not instructions. Even if a log line manages to steer it, the worst outcome is a wrong answer or a proposal you decline. It holds no permissions to misuse.

## Dockerfile checks

A suggested Dockerfile is never built or deployed by Shipyard; you review it and commit it as `Dockerfile`, and from then on it goes through the normal build. Before it is shown, it is checked:

- **Problems** (`usable: false`): doesn't start with `FROM`; asks for extra privileges; `ADD`s a URL; pipes a download into a shell; writes a secret-looking value into `ENV`/`ARG`.
- **Warnings**: runs as root, no `EXPOSE`, unpinned base image.

## Implementation

`apps/api/src/modules/ai/`:

- `model.ts`: the Claude API calls (`@anthropic-ai/sdk`): structured outputs validated by Zod schemas, a tool turn for questions, errors mapped to `AI_UNAVAILABLE` (503) and `AI_FAILED`.
- `evidence.ts`: repository evidence (known build files, 16 KB each, plus Shipyard's detection), quote verification, Dockerfile checks.
- `AiService.ts`: the features, the read-only tools and the proposal check.

Tests use a scripted fake model (`test/integration/api.integration.test.ts`, "AI assistant"). They cover access scoping, secret values masked out of prompts, dropped evidence, proposals limited to the asker's role, nothing running without a click, and the 503 when unconfigured.
