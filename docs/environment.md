# Environment variables & secrets

Code: [`modules/environment/`](../apps/api/src/modules/environment/),
[`lib/secretBox.ts`](../apps/api/src/lib/secretBox.ts), and the build/start
steps of [`DeploymentEngine`](../apps/api/src/services/deployment/DeploymentEngine.ts).

Each project has its own variables, managed on the project page or through the
API. Every value is encrypted in PostgreSQL. A variable is either:

| Available at       | Given to                                   | Allowed for secrets |
| ------------------ | ------------------------------------------ | ------------------- |
| **Runtime**        | the running container (`process.env`)      | yes                 |
| **Build**          | `docker build` as a build argument         | no                  |
| **Build + runtime** | both                                      | no                  |

A **secret** is a runtime variable whose value the API never returns again: the
dashboard shows `•••••••• secret, hidden`, and editing it means typing a new
value.

Changes apply on the **next deployment**. A running container keeps the
environment it started with, so redeploy to apply a change. That is also what
makes a rollback exact: the older deployment comes back with its own
environment.

## API

```bash
api localhost:4000/api/projects/<id>/env                       # list (secrets: value null)
api -X PUT localhost:4000/api/projects/<id>/env/DATABASE_URL \
  -H 'content-type: application/json' \
  -d '{"value":"postgres://…","secret":true}'                  # create or replace
api -X PUT localhost:4000/api/projects/<id>/env/API_URL \
  -H 'content-type: application/json' \
  -d '{"value":"https://api.example.com","target":"BOTH"}'     # RUNTIME (default) | BUILD | BOTH
api -X DELETE localhost:4000/api/projects/<id>/env/API_URL     # 204
```

Rules, checked with Zod:

- Names: `^[A-Za-z_][A-Za-z0-9_]*$`, at most 128 characters. `PORT` is
  reserved: Shipyard sets it to the port the app must listen on.
- Values: at most 32 KB, no NUL characters (Docker passes `KEY=value` as C strings).
- At most 100 variables per project.
- `secret: true` requires `target: RUNTIME`.

Other users' projects answer 404, like every other project endpoint.

## How values are protected

| Where | What happens |
| ----- | ------------ |
| PostgreSQL | Every value, secret or not, is AES-256-GCM encrypted with `SHIPYARD_SECRET_KEY` (`SecretBox`, format `v1:…`). The ciphertext is bound to `env:<projectId>:<key>` as associated data, so a value copied into another row or project won't decrypt. |
| API responses | Secrets: `value: null`, always. Non-secret values are returned to the project's owner. |
| Logs | Shipyard logs variable **names** only (`Environment: runtime API_URL, DATABASE_URL; build API_URL`), never values. |
| Image | Runtime variables are set on the **container**, not baked into the image: `docker history` never shows them. |
| Build | Build variables are passed as `--build-arg`. A generated Dockerfile declares them as `ARG NAME`, names only. Your own Dockerfile must declare the `ARG`s it uses. |

### Why secrets can't be build variables

Docker records the build arguments used by each `RUN` step in the image's
history. Anyone who can pull or inspect the image can read them with
`docker history --no-trunc`. The integration test proves it: the build
variable shows up in the history, the runtime secret doesn't. Build-time
secrets need BuildKit secret mounts (`RUN --mount=type=secret`), which is a
later item.

### If SHIPYARD_SECRET_KEY changes

Stored values can no longer be decrypted. A deploy then fails before it starts
(`failedStage: QUEUED`) with
`Environment variable X can't be decrypted. Was SHIPYARD_SECRET_KEY changed? Set the variable again.`
Nothing is guessed or skipped silently. Set the affected variables again, or
restore the old key.

## Limits

- One set of variables per project. Separate *production* and *preview*
  values arrive with preview deployments (V4).
- No build-time secrets yet (see above).
- Anyone with access to the Docker daemon can read a container's environment
  (`docker inspect`). On this single-host design that is root-equivalent anyway; see
  [security.md](security.md).
- Apps can print their own environment; Shipyard can't stop an app from
  logging a secret it was given.
