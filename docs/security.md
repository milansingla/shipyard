# Security

> **Shipyard is NOT safe for deploying untrusted code from untrusted users.**
> It is designed for a single developer (or a trusted team) deploying their
> own repositories on their own machine/server. Read on for why.

## The core fact: Docker access ≈ root

Shipyard talks to the Docker daemon. The daemon runs as root. Anyone who can
send arbitrary requests to the Docker socket can, for example, start a
container with the host's `/` mounted and read or modify anything.

Consequences:
- The Shipyard API process is effectively root-equivalent on its host.
- The Docker socket must **never** be exposed to the browser, the network, or
  deployed apps. Only the API process talks to it.
- Shipyard's own code decides which container options are used; user input
  never flows into Docker options directly (no user-controlled mounts,
  privileges, or network modes).

## Repositories are untrusted executable code

A `Dockerfile` is a program. `RUN` steps execute arbitrary commands during the
build; the resulting image executes arbitrary code at runtime. Treat every
repository as hostile.

What a malicious repository could still do in V2:
- Use CPU/memory/disk during build and runtime (only a PID limit is set today).
- Make outbound network requests (crypto mining, scanning, data exfiltration).
- Exploit a Docker/kernel vulnerability to escape the container.

What would be needed for multi-tenant safety (not in V2 scope): rootless or
remote build workers (BuildKit in a sandbox), gVisor/Kata/Firecracker
isolation, per-tenant networks, egress filtering, resource quotas, image
scanning.

## Mitigations in place (Milestone 1)

| Risk                               | Mitigation                                                                 | Where |
| ---------------------------------- | -------------------------------------------------------------------------- | ----- |
| Shell injection                    | No shell anywhere: `execFile` with argument arrays                          | `lib/process.ts` |
| git argument injection (`-u…`)     | URL + branch validated; `--` before positional args                        | `git/` |
| Dangerous git transports           | HTTPS only, host allowlist; `protocol.allow=never`, `https` re-allowed      | `repositoryUrl.ts`, `GitService.ts` |
| Leaking host git credentials       | `credential.helper=` disables keychain/credential helpers                   | `GitService.ts` |
| Hanging on auth prompts            | `GIT_TERMINAL_PROMPT=0`, clone timeout                                      | `GitService.ts` |
| Symlink tricks reading host files  | `core.symlinks=false`; Dockerfile must be a regular file (`lstat`)          | `GitService.ts`, `dockerfile.ts` |
| Path traversal in workspace        | Workspace paths verified to be direct children of the workspace root       | `WorkspaceService.ts` |
| Acting on non-Shipyard containers  | Every container op requires `shipyard.managed=true` label                   | `DockerService.inspectManagedContainer` |
| Apps exposed to the LAN            | Ports published on `127.0.0.1` by default                                   | `SHIPYARD_PUBLISH_HOST` |
| Privilege escalation in container  | `no-new-privileges`; fork-bomb limit `PidsLimit: 512`                       | `DockerService.createAndStartContainer` |
| One app starving the host          | Per-project CPU (`NanoCpus`) and memory limits, swap disabled; validated ranges | `resourceConfig`, `project.schemas.ts` |
| Invalid Docker names               | Names derived from sanitized slug + UUID, never raw input                    | `naming.ts` |
| Stack traces / secrets in API errors | Generic 500 message in production; only `AppError` messages returned      | `errorHandler.ts` |
| Secrets in logs                    | pino `redact` for auth headers, cookies, tokens                             | `logger.ts` |
| Secrets in git                     | `.env` git-ignored; only `.env.example` committed                           | `.gitignore` |
| Secrets copied into images         | `.dockerignore` applied client-side (the daemon doesn't), `.git` always excluded | `buildContext.ts` |
| Injection via generated Dockerfile | RUN lines are fixed templates; the only repo-derived value (start file) is validated and emitted as exec-form JSON | `generateDockerfile.ts`, `nodeProject.ts` |
| Generated file written via symlink | Written with `O_EXCL` under a reserved name: fails if anything exists there | `prepareBuild.ts` |
| Builds running as root             | Generated Dockerfiles install, build and run as the `node` user             | `generateDockerfile.ts` |
| Oversized repo metadata            | `package.json` / Dockerfile / `.dockerignore` size-capped, read only if regular files | `detection/files.ts` |
| Oversized request bodies           | `express.json({ limit: "100kb" })`                                          | `app.ts` |
| Strangers signing in               | `SHIPYARD_ALLOWED_GITHUB_USERS` required; re-checked on every request      | `AuthService` |
| Unauthenticated access             | Every project/deployment/GitHub route calls `requireUser`                  | `middleware/authenticate.ts` |
| Users acting on others' resources  | One `AccessService` decides every access from organization membership; non-members get 404, too-low roles 403 | `modules/access/AccessService.ts` |
| Privilege escalation inside a team | Only OWNERs grant/change/remove ADMIN and OWNER; at least one OWNER always; VIEWERs never see variable values | `OrganizationService`, `EnvironmentService` |
| Login CSRF / code interception     | OAuth `state` bound to an httpOnly cookie; PKCE S256                         | `AuthService` |
| CSRF on API calls                  | `SameSite=Lax` session cookie + `Origin`/`Sec-Fetch-Site` check on POST/DELETE | `middleware/originCheck.ts` |
| Session theft via XSS / DB leak    | `HttpOnly` cookie; DB stores sha256(token); server-side logout              | `AuthService` |
| Forged push webhooks               | HMAC-SHA256 over the raw body, constant-time compare; verified before anything else is read | `modules/webhooks/signature.ts` |
| Replayed / duplicated deliveries   | Delivery id stored before acting; duplicates are no-ops                      | `WebhookService` |
| Webhook payload choosing what runs | Payload only *selects* projects; clone URL and branch come from the project | `WebhookService` |
| Server paths in error messages     | git failures explained; workspace paths never shown                           | `GitService.explainGitFailure` |
| Untraceable changes                | Audit log of project, deployment, rollback, variable, domain and key changes, with the actor | `AuditService` |
| API key theft from the database    | Only sha256(key) stored; the key is shown once; `shp_` prefix for secret scanners | `ApiKeyService` |
| A leaked API key escalating        | Keys can't create keys (needs a browser session); revocable, optional expiry, allowlist re-checked per request | `apiKey.routes.ts`, `AuthService.authenticateApiKey` |
| GitHub token leak                  | AES-256-GCM at rest; never in API responses; scope `read:user`              | `lib/secretBox.ts` |
| Secret values in the database       | Every env value AES-256-GCM encrypted, bound to project+key (copied ciphertexts don't decrypt) | `EnvironmentService`, `SecretBox` |
| Secrets in API responses / logs    | Secret values never returned; logs carry variable names only               | `EnvironmentService`, `DeploymentEngine` |
| Secrets in image layers            | Runtime variables set on the container, not the image; secrets can't be build args (they'd be in `docker history`) | `environment.schemas.ts` |
| Overriding Shipyard's own settings | `PORT` reserved; names/values validated (no NUL, 32 KB max, 100 per project) | `environment.schemas.ts` |
| Floods / brute force / runaway scripts | Rate limits: sign-in 60/min and webhooks 300/min per IP; per user 20 deploys, 120 other changes, 1200 reads, 10 AI assistant requests per minute; 10 log streams. 429 with `Retry-After` and `RateLimit-*` headers | `middleware/rateLimit.ts` |
| Spoofed client IPs                 | `X-Forwarded-For` ignored unless `SHIPYARD_TRUST_PROXY` names a trusted proxy (the dashboard proxy passes client-sent values through) | `app.ts` |
| Reverse proxy as a path to root    | Traefik gets no Docker socket: it only reads the route file, mounted read-only | `docker-compose.yml` |
| Injection into proxy config        | Route values validated (DNS-label slugs/names, port range, id charset); file written as JSON | `TraefikRouter.ts` |
| Bypassing the proxy                | With routing on, containers may only publish on 127.0.0.1 (config refuses `0.0.0.0`) | `config/env.ts` |
| Spoofed forwarding headers         | Traefik drops alias headers like `X_Forwarded_For`                          | `docker-compose.yml` |
| Traffic to an unhealthy version    | Route moves only after the health check, and only counts once Traefik confirms it | `DeploymentEngine`, `TraefikRouter` |

### Added in V5

| Risk | Mitigation | Where |
| --- | --- | --- |
| Rogue machines joining as workers | Registration needs `SHIPYARD_WORKER_JOIN_TOKEN` (constant-time compare, rate-limited per IP); each worker then gets its own `shpw_` secret, stored as sha256 | `WorkerRegistry` |
| A worker answering another worker's calls | Every call is bound to the worker it was sent to; anything else is 404 | `WorkerCalls.waiterOf` |
| Secrets in the database's call log | Engine calls carry decrypted variables, so they travel only in memory; `worker_calls` stores a redacted summary | `WorkerCalls` |
| Stale access after removal | Removing someone from an organization also removes them from its teams, so an old grant can't revive if they're re-added | `OrganizationService.removeMember` |
| Team grants escalating | A team grants VIEWER, DEVELOPER or ADMIN on projects of its own organization, never OWNER; only org ADMINs change teams | `TeamService` |
| Over-powered automation | Service accounts are never OWNER and sign in only with API keys; keys are scoped read / deploy / write and never exceed their owner's role | `ServiceAccountService`, `middleware/apiKeyScopes.ts` |
| SSRF through alert channels | HTTPS only, no credentials in URLs, no redirects; addresses checked at connect time (not just beforehand), so DNS rebinding can't reach private networks or cloud metadata | `services/notify/NotificationProvider.ts` |
| Channel URLs leaking (they are credentials) | Encrypted at rest; shown masked | `AlertService` |
| Breaking the rules by deploying | Organization policies (resource caps, health check required, domain suffixes, approval) are checked on every deploy and domain change, by the API, not the dashboard | `PolicyService` |
| Untrusted pull requests | PRs from forks are never built; previews only get secrets set for Preview, never production ones (database URLs included) | `pullRequestEvent.ts`, `EnvironmentService.forDeployment` |
| Audit search as an injection point | Bound parameters; `LIKE` wildcards in the user's text escaped | `AuditService` |
| Backups running shell commands | `pg_dump` / `pg_restore` / `tar` run through Docker exec with argument arrays; manifest file names validated; sha256 per file checked before restoring | `ops/BackupService.ts` |
| The AI assistant overstepping | It reads only through the asker's access checks, has no write tools (changes come back as proposals the user runs through the normal API), never receives variable values, and secret values printed in logs are masked before sending; quoted evidence is verified | `modules/ai/`, [ai.md](ai.md) |

Details of the sign-in design: [github.md](github.md).

## Known gaps (tracked)

- **Signed-in users are trusted with the host.** Ownership stops users touching
  *each other's* projects, but any allowed user can deploy code that runs
  here (see "Docker access ≈ root" above). Only allowlist people you trust.
- Rate limits are per API process (in memory) and per IP behind a shared
  proxy address unless `SHIPYARD_TRUST_PROXY` names a proxy that sets
  `X-Forwarded-For` itself.
- Sessions have a fixed lifetime; there is no "sign out everywhere" endpoint
  yet (deleting the user's `sessions` rows does it).
- A cancelled build (timeout, `SHIPYARD_BUILD_TIMEOUT_MS`) may leave dangling
  image layers; reclaim with `docker image prune`.
- CPU/memory limits are per project and **off by default** (a limit that is
  too low breaks apps in confusing ways). Set them for anything you don't
  fully trust; disk and network bandwidth are not limited yet.
- No egress restrictions for deployed containers.
- PostgreSQL services have no failover; backups are taken by `npm run backup` on
  the machine they run on ([operations.md](operations.md)).
- Volumes have no size limit: an app can fill the server's disk through one.
  Detached volumes keep their data until removed with `docker volume rm`.
- Each project's services talk on their own network (databases are only there),
  but public web services also join `shipyard-edge` for Traefik, so they can
  reach each other by container name.
- **Workers are trusted.** Anyone with the join token can register a worker;
  a worker receives the decrypted variables of the deploys it runs, and Traefik
  sends app traffic to the address it registers. Treat the join token like a
  root password, and use an `https://` control-plane URL so worker secrets and
  variables aren't sent in clear text.
- Content that reaches the AI assistant (logs, repository files) is written by
  app authors and can try to steer the model. It holds no permissions, so the
  worst case is a wrong answer or a proposal the user declines; but its
  answers are advice, not verified facts.
- One webhook secret for all repositories: anyone who has it can make Shipyard
  redeploy the **latest commit** of any project's branch (never other code —
  the clone URL comes from the project, not the payload). Per-project secrets
  are a V3 item. Rotate it by changing `GITHUB_WEBHOOK_SECRET` and every
  repository's webhook.
- A push received while Shipyard restarts mid-deploy is not replayed (the
  "deploy again when done" mark is in memory). Push again, or redeliver from
  GitHub's webhook page.
