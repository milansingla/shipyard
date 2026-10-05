# GitHub sign-in and repository selection

Code: [`modules/auth/`](../apps/api/src/modules/auth/),
[`services/github/GitHubClient.ts`](../apps/api/src/services/github/GitHubClient.ts),
[`middleware/authenticate.ts`](../apps/api/src/middleware/authenticate.ts)

## Setup

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/api/auth/github/callback`
     (always `<SHIPYARD_PUBLIC_URL>/api/auth/github/callback`; browsers reach the
     API through the dashboard, which proxies `/api`)
2. Generate a client secret.
3. In `.env`:
   ```bash
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   SHIPYARD_SECRET_KEY=$(openssl rand -base64 32)   # paste the generated value
   SHIPYARD_ALLOWED_GITHUB_USERS=your-github-login     # comma-separated
   ```
4. Keep `SHIPYARD_PUBLIC_URL=http://localhost:3000` and `SHIPYARD_APP_URL=http://localhost:3000`
   (the `.env.example` values).
5. `npm run db:deploy`, then `npm run dev:api` and `npm run dev:web` in two
   terminals, and open <http://localhost:3000>. **Sign in with GitHub** takes
   you to GitHub and back to the dashboard.

> Created the OAuth App with a `localhost:4000` callback (the M4 instructions)?
> Change it to `localhost:3000` — GitHub rejects a callback URL that doesn't match.

**Who may sign in.** Anyone who signs in can deploy code that runs on this
host, so the allowlist is required. It is checked at sign-in *and* on every
request: removing a login (and restarting) locks that person out immediately.
`*` allows any GitHub account — only for an isolated test machine.

A failed sign-in (cancelled, not allowlisted, expired) returns the browser to
the dashboard with `?signin_error=<code>`, which it explains.

Until all four variables are set, the API starts but every project/deployment
endpoint answers `503 AUTH_NOT_CONFIGURED`, with a message saying what to set.

## Sign-in flow

```
Browser                    Shipyard API                         GitHub
   │ GET /api/auth/github/login │                                  │
   │───────────────────────────►│ state, verifier = random 32 bytes │
   │◄── 302 to github.com ──────│ cookie shipyard_oauth = state.verifier (httpOnly, 10 min)
   │        ?state&code_challenge=sha256(verifier)                 │
   │──────────────────────────────────────────────────────────────►│ user clicks Authorize
   │◄── 302 /api/auth/github/callback?code&state ──────────────────│
   │───────────────────────────►│ state == cookie state? (constant-time)
   │                            │ POST access_token {code, verifier, secret} ─►│
   │                            │ GET /user ───────────────────────────────────►│
   │                            │ upsert User (token AES-256-GCM encrypted)     │
   │                            │ Session row id = sha256(random token)         │
   │◄── 302 SHIPYARD_APP_URL ───│ cookie shipyard_session = token (httpOnly, Lax)
```

| Protection | Against |
| --- | --- |
| `state`, checked against an httpOnly cookie | Login CSRF: an attacker finishing a sign-in in *your* browser with *their* account |
| PKCE (`S256`) | A stolen authorization code being redeemed elsewhere |
| `SHIPYARD_ALLOWED_GITHUB_USERS`, re-checked per request | Strangers with a GitHub account running code on your server |
| Scope `read:user` only | A leaked token granting access to anyone's private code |
| Token encrypted at rest | A database dump exposing usable GitHub tokens |
| Session id = sha256(token) | A database dump exposing usable sessions |
| `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, `__Host-` prefix over HTTPS | Script access to the session, cross-site requests, cookie injection from subdomains |
| `Origin` check on POST/DELETE | Cross-site requests (CSRF) that SameSite alone might let through |

Users are keyed by GitHub's numeric id, not `login` — logins can be renamed and
then claimed by someone else.

## Sessions

- Lifetime: `SHIPYARD_SESSION_TTL_HOURS` (default 30 days), fixed from sign-in.
- `POST /api/auth/logout` deletes the session row: the cookie is dead immediately,
  even if someone copied it.
- Expired rows are deleted when used and at API startup.
- Changing `SHIPYARD_SECRET_KEY` does not end sessions, but GitHub calls then ask
  users to sign in again (their stored token can't be decrypted).

## Authorization

Every project belongs to the user who created it. Services take the acting
user's id and query `WHERE ownerId = …` (deployments: via their project). A
project or deployment of someone else is a **404**, never a 403, so ids can't be
probed. Covered for every endpoint by `api.integration.test.ts`.

## Repository selection

| Endpoint | Returns |
| --- | --- |
| `GET /api/github/repos?page=` | The user's repositories (50/page, recently updated first), each with `repositoryUrl` and `deployable` |
| `GET /api/github/repos/:owner/:repo/branches?page=` | Branch names (100/page) |

The dashboard (M5) uses these to fill `POST /api/projects`
`{ repositoryUrl, branch }`. Calls use the signed-in user's own token, so they
only show what GitHub shows that user.

**Private repositories** are listed with `deployable: false`. Cloning them needs
credentials; the right tool is a GitHub App with per-repository permissions,
not the broad `repo` OAuth scope. Planned after V2.

## Errors

| Code | When |
| --- | --- |
| `UNAUTHENTICATED` (401) | No/expired session, or GitHub revoked the token → sign in again |
| `AUTH_NOT_CONFIGURED` (503) | GitHub sign-in variables not set |
| `OAUTH_FAILED` (400) | Cancelled, state mismatch, expired/reused code |
| `FORBIDDEN` (403) | GitHub account not on the allowlist, or a state-changing request from another site |
| `GITHUB_ERROR` (502/503) | GitHub unreachable, unexpected response, or rate limit |

## Deploy on push (webhooks)

Code: [`modules/webhooks/`](../apps/api/src/modules/webhooks/)

**Setup, once per repository**

1. Put a random secret in `.env`: `GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)`
   (paste the generated value) and restart the API.
2. GitHub repository → **Settings → Webhooks → Add webhook**:
   - Payload URL: `<dashboard URL>/api/webhooks/github` (the project page shows it)
   - Content type: `application/json`
   - Secret: the same value
   - Events: **Just the push event**
3. GitHub sends a `ping`; the delivery should show a green tick and `pong`.

GitHub has to reach the URL. On a laptop, forward it with a tunnel:
`npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/api/webhooks/github`
(use the smee.io URL as the Payload URL), or `cloudflared tunnel --url http://localhost:3000`.

**What happens on a push**

```
POST /api/webhooks/github
  │ X-Hub-Signature-256 = HMAC-SHA256(secret, raw body)?   no → 401, nothing read or stored
  │ X-GitHub-Delivery already recorded?                    yes → 200 "already handled"
  │ event = ping → "pong" · other events → ignored
  │ push to refs/heads/<branch>? (tags, deletions → ignored)
  ▼
every project with that repository (case-insensitive) AND branch
  ├─ idle → new deployment, trigger PUSH
  └─ busy → marked; ONE deploy of the latest commit runs when the current one ends
```

- The route reads the **raw** body (it is mounted before `express.json()`):
  the signature covers exact bytes, and re-serialised JSON would not match.
- The response is 200 as soon as deployments are *started*; GitHub only
  waits ~10 s and doesn't care about the build.
- Coalescing: five pushes during a build produce one more deployment, of the
  branch's newest commit — not five.
- Deployments record their trigger; the dashboard marks push deployments.

| Response | Meaning |
| --- | --- |
| 200 `pong` / `deploying …` / `queued …` / `ignored: …` | Accepted; the outcome is also stored |
| 200 `duplicate: true` | GitHub retried a delivery already handled |
| 401 | Signature missing or wrong — check the secret matches `.env` |
| 415 | Webhook content type is form-encoded; set `application/json` |
| 503 `WEBHOOKS_NOT_CONFIGURED` | `GITHUB_WEBHOOK_SECRET` is not set |
