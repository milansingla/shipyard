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
| Invalid Docker names               | Names derived from sanitized slug + UUID, never raw input                    | `naming.ts` |
| Stack traces / secrets in API errors | Generic 500 message in production; only `AppError` messages returned      | `errorHandler.ts` |
| Secrets in logs                    | pino `redact` for auth headers, cookies, tokens                             | `logger.ts` |
| Secrets in git                     | `.env` git-ignored; only `.env.example` committed                           | `.gitignore` |
| Oversized request bodies           | `express.json({ limit: "100kb" })`                                          | `app.ts` |

## Known gaps (tracked)

- **No authentication on the API yet** — it only exposes `/api/health` in M1.
  Every deployment endpoint (M2+) must require an authenticated session (M4).
  Until then, keep the API bound to localhost.
- **No build timeout** — a hung `docker build` blocks its deployment forever, and a killed
  build leaves unlabelled intermediate layers. Planned for M2 (build deadline + cleanup).
- No memory/CPU limits on containers (would break some apps without per-project config).
- No egress restrictions for deployed containers.
- Build context respects `.git` exclusion only, not the repo's `.dockerignore`.
- Webhook signature verification arrives with webhooks (M6) — HMAC-SHA256,
  constant-time compare, raw body.
- GitHub access tokens (M4) will be stored server-side only, never sent to the browser.
