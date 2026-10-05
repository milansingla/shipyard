# GitHub sign-in and repository selection

Code: [`modules/auth/`](../apps/api/src/modules/auth/),
[`services/github/GitHubClient.ts`](../apps/api/src/services/github/GitHubClient.ts),
[`middleware/authenticate.ts`](../apps/api/src/middleware/authenticate.ts)

## Setup

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
   - Homepage URL: `http://localhost:4000`
   - Authorization callback URL: `http://localhost:4000/api/auth/github/callback`
     (always `<SHIPYARD_PUBLIC_URL>/api/auth/github/callback`)
2. Generate a client secret.
3. In `.env`:
   ```bash
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   SHIPYARD_SECRET_KEY=$(openssl rand -base64 32)   # paste the generated value
   SHIPYARD_ALLOWED_GITHUB_USERS=your-github-login     # comma-separated
   ```
4. `npm run db:deploy && npm run dev:api`, then open
   <http://localhost:4000/api/auth/github/login> in a browser.
   After authorizing you land on `SHIPYARD_APP_URL`; `GET /api/auth/me` now returns you.

**Who may sign in.** Anyone who signs in can deploy code that runs on this
host, so the allowlist is required. It is checked at sign-in *and* on every
request: removing a login (and restarting) locks that person out immediately.
`*` allows any GitHub account — only for an isolated test machine.

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
