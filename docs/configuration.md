# Configuration as code: `shipyard.yaml`

Code: [`services/config/shipyardConfig.ts`](../apps/api/src/services/config/shipyardConfig.ts)
(parsing), [`modules/services/ConfigSync.ts`](../apps/api/src/modules/services/ConfigSync.ts) (applying it).

Commit a `shipyard.yaml` (or `shipyard.yml`) at the repository root to
declare a project's services next to its code:

```yaml
version: 1
services:
  web:                      # service name: lowercase, ≤ 20 chars
    type: web               # web (default) | worker
    source: apps/web        # directory to build (default: the root)
    build:
      command: npm run build
    start:
      command: npm start
    port: 3000
    public: true            # web only; default true
    replicas: 2             # identical containers, load-balanced; 1–10
    healthCheck:
      path: /healthz
      port: 9000
      timeoutSeconds: 60
    resources:
      cpu: 0.5
      memoryMb: 512
    volumes:                # name: mount path. Kept across deployments
      uploads: /app/public/uploads
  api:
    source: apps/api
    port: 4000
    public: false           # reachable by the other services as http://api:4000
  jobs:
    type: worker
    source: apps/worker
    start:
      command: node worker.js
  db:
    type: postgres          # a database: version and resources only
    version: 17             # see databases.md
```

## When it is read

On every deploy (from the dashboard, the CLI, the API or a push), Shipyard
reads the file at the branch's latest commit. A blobless, checkout-free
shallow clone downloads only that one file, before anything is built. Then:

- services the file declares are **created** or **updated**;
- services the file no longer declares are **kept as they are**, and the
  build log says so. Shipyard never deletes a running service on its own:
  delete it on the project page;
- the build log of each deployment starts with what changed
  (`shipyard.yaml: added service api`, `updated web: port`);
- a `type: postgres` service is created with its password and URL
  ([databases.md](databases.md)). Afterwards only its resources follow the
  file: its version never changes, and a service never switches between
  being a database and being built from the repository (the deploy fails,
  saying so);
- **volumes** the file declares are added. A volume taken out of the file,
  or given another path, stays as it is (the build log says so): moving or
  detaching stored data is done on the project page. See
  [services.md](services.md#persistent-volumes).

## Precedence

Lowest to highest:

1. **Platform defaults**: a public web service at the root, port 3000.
2. **Automatic detection**: the repository's Dockerfile, its `EXPOSE`, the Node.js scripts.
3. **`shipyard.yaml`**.
4. **Dashboard settings**: a setting changed on the project page (or with
   `PATCH /api/services/:id`) is remembered in the service's `overrides`,
   and the file no longer overwrites it. The build log says when that
   happens: `kept the dashboard's port for api`.
5. **Deployment overrides**: not available yet. Each deploy builds the
   branch's latest commit with the settings above.

Project-wide settings (health check, resources, restart policy) are the
defaults for every service. A service's own setting, from the file or the
dashboard, wins over them.

## Errors

The file is validated strictly: unknown keys, wrong types, unsafe
directories (`..`), multi-line commands, workers marked public. YAML aliases
are capped, so a small file can't expand into a huge document. Files over
64 KB and symlinked files are refused.

An invalid file still produces a deployment: **FAILED** at QUEUED, with the
exact problem as its error (`shipyard.yaml is invalid at services.web:
Unrecognized key: "sorce"`). A push with a broken file is therefore visible
in the history instead of silently doing nothing. Nothing is built, and the
running versions keep serving.
