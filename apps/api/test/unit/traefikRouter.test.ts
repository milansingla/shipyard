import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError, ErrorCode } from "../../src/lib/errors.js";
import { DirectPortRouter, type RouteTarget, isValidHostname } from "../../src/services/routing/Router.js";
import {
  ROUTES_FILE,
  type RouteProbe,
  type TraefikDynamicConfig,
  TraefikRouter,
  createTraefikProbe,
  traefikConfig,
} from "../../src/services/routing/TraefikRouter.js";
import { silentLogger } from "../helpers/silentLogger.js";

const target = (name: string, deploymentId: string): RouteTarget => ({
  name,
  deploymentId,
  containerName: `shipyard-${name}-${deploymentId}`,
  containerPort: 3000,
});

let routesDir: string;

beforeEach(async () => {
  routesDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-routes-"));
});
afterEach(async () => {
  await fs.rm(routesDir, { recursive: true, force: true });
});

/**
 * A stand-in for Traefik: it "serves" whatever the routes file says, like the
 * real one after a reload. `lagChecks` probes still see the old table, the way
 * Traefik takes a moment to pick up a change.
 */
function fakeTraefik(options: { down?: boolean; lagChecks?: number } = {}) {
  let lag = 0;
  let lastFile = "";
  const probes: string[] = [];
  const probe: RouteProbe = async (hostname) => {
    probes.push(hostname);
    if (options.down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const file = await fs.readFile(path.join(routesDir, ROUTES_FILE), "utf8");
    if (file !== lastFile) [lastFile, lag] = [file, options.lagChecks ?? 0];
    if (lag-- > 0) return null;
    return servedBy(JSON.parse(file), hostname);
  };
  return { probe, probes };
}

function servedBy(config: TraefikDynamicConfig, hostname: string): string | null {
  for (const [id, router] of Object.entries(config.http?.routers ?? {}) as [string, { rule: string }][]) {
    if (router.rule === `Host(\`${hostname}\`)`) {
      const middleware = config.http!.middlewares[id] as { headers: { customResponseHeaders: Record<string, string> } };
      return middleware.headers.customResponseHeaders["X-Shipyard-Deployment"] ?? null;
    }
  }
  return null;
}

function router(probe: RouteProbe, httpPort = 80): TraefikRouter {
  return new TraefikRouter(
    { network: "shipyard-edge", domain: "localhost", httpPort, routesDir, cutoverTimeoutMs: 200, probeIntervalMs: 5 },
    probe,
    silentLogger,
  );
}

async function table(): Promise<TraefikDynamicConfig> {
  return JSON.parse(await fs.readFile(path.join(routesDir, ROUTES_FILE), "utf8"));
}

async function liveRoutes(): Promise<Record<string, string | null>> {
  const config = await table();
  return Object.fromEntries(
    Object.values(config.http?.routers ?? {}).map((r) => {
      const host = /Host\(`(.+)`\)/.exec((r as { rule: string }).rule)![1]!;
      return [host, servedBy(config, host)];
    }),
  );
}

describe("traefikConfig", () => {
  it("builds one router, service and deployment-header middleware per route", () => {
    expect(traefikConfig([target("web", "d2"), target("api", "d1")], "apps.example.com")).toEqual({
      http: {
        routers: {
          "shipyard-api": {
            rule: "Host(`api.apps.example.com`)",
            entryPoints: ["web"],
            service: "shipyard-api",
            middlewares: ["shipyard-api"],
          },
          "shipyard-web": {
            rule: "Host(`web.apps.example.com`)",
            entryPoints: ["web"],
            service: "shipyard-web",
            middlewares: ["shipyard-web"],
          },
        },
        services: {
          "shipyard-api": { loadBalancer: { servers: [{ url: "http://shipyard-api-d1:3000" }] } },
          "shipyard-web": { loadBalancer: { servers: [{ url: "http://shipyard-web-d2:3000" }] } },
        },
        middlewares: {
          "shipyard-api": { headers: { customResponseHeaders: { "X-Shipyard-Deployment": "d1" } } },
          "shipyard-web": { headers: { customResponseHeaders: { "X-Shipyard-Deployment": "d2" } } },
        },
      },
    });
  });

  it("load-balances a deployment's replicas, checking each when a health path is set", () => {
    const config = traefikConfig(
      [{ ...target("web", "d1"), replicaContainers: ["shipyard-web-d1-r2"], healthCheck: { path: "/healthz", port: 9000 } }],
      "localhost",
    );
    expect(config.http!.services["shipyard-web"]).toEqual({
      loadBalancer: {
        servers: [{ url: "http://shipyard-web-d1:3000" }, { url: "http://shipyard-web-d1-r2:3000" }],
        healthCheck: { path: "/healthz", port: 9000, interval: "2s", timeout: "2s" },
      },
    });
    // One container: nothing to fail over to, so no check.
    const single = traefikConfig([{ ...target("web", "d1"), healthCheck: { path: "/healthz", port: null } }], "localhost");
    expect(single.http!.services["shipyard-web"]).toEqual({ loadBalancer: { servers: [{ url: "http://shipyard-web-d1:3000" }] } });
  });

  it("writes an empty table as {}: Traefik would ignore one with empty sections", () => {
    expect(traefikConfig([], "localhost")).toEqual({});
  });
});

describe("TraefikRouter", () => {
  it("builds stable URLs from the project name, omitting port 80", () => {
    expect(router(fakeTraefik().probe).urlFor("myapp")).toBe("http://myapp.localhost");
    expect(router(fakeTraefik().probe, 8000).urlFor("myapp")).toBe("http://myapp.localhost:8000");
  });

  it("activate() returns only once the proxy serves the new deployment", async () => {
    const traefik = fakeTraefik({ lagChecks: 3 });
    const r = router(traefik.probe);
    await r.sync([target("myapp", "old")]);

    await r.activate(target("myapp", "new"));

    expect(await liveRoutes()).toEqual({ "myapp.localhost": "new" });
    expect(traefik.probes.length).toBe(4); // 3 × still old, then new
  });

  it("puts the previous route back when traffic doesn't move in time", async () => {
    const r = router(fakeTraefik({ lagChecks: 1000 }).probe);
    await r.sync([target("myapp", "old")]);

    const error = await r.activate(target("myapp", "new")).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ErrorCode.ROUTING_FAILED);
    expect((error as AppError).message).toContain("myapp.localhost");
    expect(await liveRoutes()).toEqual({ "myapp.localhost": "old" });
  });

  it("explains a proxy that isn't running, and leaves no route behind", async () => {
    const r = router(fakeTraefik({ down: true }).probe);
    await r.sync([]);

    const error = (await r.activate(target("myapp", "new")).catch((e: unknown) => e)) as AppError;

    expect(error.message).toMatch(/ECONNREFUSED.*Is Traefik running\? Start it with `npm run db:up`/s);
    expect(await liveRoutes()).toEqual({});
  });

  it("deactivate() only removes a route that still points at that deployment", async () => {
    const r = router(fakeTraefik().probe);
    await r.sync([target("myapp", "new"), target("other", "o1")]);

    await r.deactivate("myapp", "old"); // a retired deployment: the route moved on already
    expect(await liveRoutes()).toEqual({ "myapp.localhost": "new", "other.localhost": "o1" });

    await r.deactivate("myapp", "new");
    expect(await liveRoutes()).toEqual({ "other.localhost": "o1" });
  });

  it("keeps every route when several projects switch at once", async () => {
    const r = router(fakeTraefik().probe);
    await r.sync([]);

    await Promise.all(["a", "b", "c", "d"].map((name) => r.activate(target(name, `${name}1`))));

    expect(await liveRoutes()).toEqual({
      "a.localhost": "a1",
      "b.localhost": "b1",
      "c.localhost": "c1",
      "d.localhost": "d1",
    });
  });

  it("sync() replaces the whole table and leaves only the routes file", async () => {
    const r = router(fakeTraefik().probe);
    await r.sync([target("gone", "g1")]);
    await r.sync([target("kept", "k1")]);

    expect(await liveRoutes()).toEqual({ "kept.localhost": "k1" });
    expect(await fs.readdir(routesDir)).toEqual([ROUTES_FILE]);
  });

  it.each([
    [{ name: "My App" }],
    [{ name: "a`) || Host(`evil" }],
    [{ name: "-app" }],
    [{ containerName: "x:80/evil" }],
    [{ deploymentId: 'id"' }],
    [{ containerPort: 0 }],
  ])("refuses to write a route with %j", async (bad) => {
    const r = router(fakeTraefik().probe);
    await expect(r.activate({ ...target("myapp", "d1"), ...bad })).rejects.toMatchObject({
      code: ErrorCode.ROUTING_FAILED,
    });
    await expect(fs.readdir(routesDir)).resolves.toEqual([]);
  });
});

describe("createTraefikProbe", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    // Answers like Traefik: by Host header, with the deployment header on routed hosts.
    server = http.createServer((req, res) => {
      if (req.headers.host === "myapp.localhost") res.setHeader("X-Shipyard-Deployment", "d1");
      res.writeHead(req.headers.host === "myapp.localhost" ? 200 : 404).end("body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("asks for the hostname via the Host header and reports who served it", async () => {
    const probe = createTraefikProbe(port, 1_000);
    expect(await probe("myapp.localhost")).toBe("d1");
    expect(await probe("unknown.localhost")).toBeNull();
  });

  it("fails when nothing listens", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const freePort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    await expect(createTraefikProbe(freePort, 1_000)("myapp.localhost")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("DirectPortRouter", () => {
  it("reaches each deployment on its own port and needs no network", async () => {
    const r = new DirectPortRouter();
    expect(r.network).toBeNull();
    expect(r.urlFor("myapp", 49153)).toBe("http://localhost:49153");
    await expect(r.activate()).resolves.toBeUndefined();
  });
});

describe("custom domains and HTTPS", () => {
  it("routes custom hostnames to the same deployment, over HTTPS with Let's Encrypt when enabled", () => {
    const config = traefikConfig([{ ...target("shop", "d1"), aliases: ["shop.example.com", "www.shop.example.com"] }], "apps.example.com", true);
    expect(config.http?.routers["shipyard-shop"]).toEqual({
      rule: "Host(`shop.apps.example.com`) || Host(`shop.example.com`) || Host(`www.shop.example.com`)",
      entryPoints: ["websecure"],
      service: "shipyard-shop",
      middlewares: ["shipyard-shop"],
      tls: { certResolver: "letsencrypt" },
    });
  });

  it("builds https URLs, omitting port 443", () => {
    const options = { network: "n", domain: "apps.example.com", httpPort: 80, routesDir, cutoverTimeoutMs: 100, probeIntervalMs: 5 };
    expect(new TraefikRouter({ ...options, tls: { httpsPort: 443 } }, async () => null, silentLogger).urlFor("shop")).toBe(
      "https://shop.apps.example.com",
    );
    expect(new TraefikRouter({ ...options, tls: { httpsPort: 8443 } }, async () => null, silentLogger).urlFor("shop")).toBe(
      "https://shop.apps.example.com:8443",
    );
  });

  it.each(["app.example.com", "a.b.c.example.org", "xn--bcher-kva.example"])("accepts the hostname %s", (hostname) => {
    expect(isValidHostname(hostname)).toBe(true);
  });

  it.each(["localhost", "1.2.3.4", "*.example.com", "App.example.com", "example.com:80", "http://example.com", "a..com", "-a.com", "a.com/x"])(
    "rejects the hostname %s",
    (hostname) => {
      expect(isValidHostname(hostname)).toBe(false);
    },
  );

  it("refuses to route an invalid alias", async () => {
    const r = router(fakeTraefik().probe);
    await expect(r.activate({ ...target("shop", "d1"), aliases: ["evil`) || Host(`x"] })).rejects.toMatchObject({
      code: ErrorCode.ROUTING_FAILED,
    });
  });
});

