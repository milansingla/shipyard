# Dashboard

Code: [`apps/web`](../apps/web) — Next.js 16 (App Router), React 19, Tailwind CSS 4.

```bash
npm run dev:web    # http://localhost:3000 (the API must be running: npm run dev:api)
npm test -w @shipyard/web
```

## How it talks to the API

```
Browser ──► localhost:3000 ──┬─ /, /projects/…, /deployments/…  → Next.js pages
                             └─ /api/*  ──rewrite (proxy)──►  localhost:4000/api/*  (Express API)
```

Every browser request goes to **one origin**. `next.config.ts` rewrites
`/api/*` to `SHIPYARD_API_URL` (default `http://127.0.0.1:4000`). Consequences:

- **No CORS** configuration, and no credentials-with-CORS pitfalls.
- The session cookie is first-party and `SameSite=Lax` keeps working.
- The API's Origin check sees `http://localhost:3000`, which is `SHIPYARD_APP_URL`.
- The OAuth callback goes through the dashboard too, so `SHIPYARD_PUBLIC_URL`
  and the GitHub OAuth App callback use port 3000.

The dashboard holds **no secrets and no business logic**: it never sees GitHub
tokens or session tokens (httpOnly), and every rule — ownership, state
transitions, validation — is enforced by the API. Pages are client components
that call the API and render what it returns.

Data is refreshed by polling while something is changing (a deployment
in progress: every 1.5 s; logs while live: every 2 s), and not at all
otherwise. WebSockets/SSE are planned for V3 log streaming.

Security headers: `frame-ancestors 'none'` / `X-Frame-Options: DENY` (the
dashboard triggers deployments, so it must not be framed — clickjacking),
`nosniff`, `Referrer-Policy: same-origin`. Deployment URLs are only rendered as
links when they are `http(s)` (`lib/format.ts → safeHttpUrl`).

## Structure

| Path | What |
| --- | --- |
| `components/SessionGate.tsx` | Asks `/api/auth/me`; renders sign-in, setup instructions, or the app |
| `app/page.tsx` | Projects with their latest deployment |
| `app/projects/new` | Repository picker → branch → **Create and deploy** |
| `app/projects/[id]` | Deployment history, deploy, delete |
| `app/deployments/[id]` | Stage scale, facts, stop / restart / redeploy, logs |
| `lib/api.ts` | `fetch` wrapper: unwraps `{ data }`, turns errors into `ApiError` |
| `lib/useApi.ts` | Load + optional polling; a 401 anywhere returns to sign-in |
| `lib/status.ts` | Status → label, tone, stage on the scale (unit-tested) |

## Visual language

The interface borrows from a hull in dry dock, without nautical jargon in the
copy — buttons say *Deploy*, *Stop*, *Logs*.

| Token | Hex | Meaning |
| --- | --- | --- |
| primer | `#e7eae8` | page |
| ink | `#13212b` | text, log panel |
| sea | `#16705f` | **Running** |
| signal | `#e8b007` | **in progress** (code-flag yellow) |
| oxide | `#9f2f28` | **Failed**, and the hull below the waterline |
| rivet | `#c3cac7` | rules, **Stopped** |

Every colour that carries meaning maps to exactly one state.

Type: *Big Shoulders Stencil* for the wordmark and project names (painted hull
numbers), *Big Shoulders* for headings and labels, *Public Sans* for text,
*IBM Plex Mono* for commits, ports and logs.

**The waterline** is the signature: the wordmark is painted ink above it and
anti-fouling red below. On a deployment page the pipeline is drawn as draft
marks — stages numbered 1–6 from the bottom — and the water rises to the stage
the deployment has reached. A failed deployment's waterline turns oxide at the
stage that failed (inferred from what it produced: no commit → clone, commit
but no container → detect/build, container → start/health check). This is the
only animation; it is disabled under `prefers-reduced-motion`.

## Verifying it

Unit tests cover the status model, formatting and the API client. The pages
were checked end to end against the real API (PostgreSQL test database,
seeded deployments in every state) in a headless browser at desktop and
mobile widths.
