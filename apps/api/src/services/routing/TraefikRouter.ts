import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { AppError, ErrorCode, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { type RouteTarget, type Router, isValidHostname } from "./Router.js";

/** Docker network shared by Traefik and every deployment container (created by docker-compose.yml). */
export const EDGE_NETWORK = "shipyard-edge";
/** Traefik entry point for plain HTTP (see docker-compose.yml). */
export const ENTRY_POINT = "web";
/** Traefik entry point for HTTPS (docker-compose.production.yml). */
export const TLS_ENTRY_POINT = "websecure";
/** Certificate resolver defined in docker-compose.production.yml (Let's Encrypt). */
export const CERT_RESOLVER = "letsencrypt";
/** The one file Shipyard writes into Traefik's dynamic configuration directory. */
export const ROUTES_FILE = "routes.yml";
/** Added by Traefik to every response it proxies: which deployment answered. */
export const DEPLOYMENT_HEADER = "X-Shipyard-Deployment";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** http://<host or IPv4>:<port>, nothing else: it goes into Traefik's configuration. */
const SERVER_URL = /^http:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface TraefikRouterOptions {
  /** Docker network Traefik and deployment containers share (EDGE_NETWORK outside tests). */
  network: string;
  /** Hostname suffix: a route named "myapp" is served at myapp.<domain>. */
  domain: string;
  /** Port Traefik listens on, on this host. */
  httpPort: number;
  /** Mounted read-only into Traefik as its dynamic configuration directory. */
  routesDir: string;
  /** How long Traefik may take to pick up a route change (it applies at most one every ~2s). */
  cutoverTimeoutMs: number;
  probeIntervalMs: number;
  /** Serve over HTTPS with Let's Encrypt certificates; null = plain HTTP. */
  tls?: { httpsPort: number } | null;
}

/** Asks the proxy for `hostname`; returns the deployment id it was served by (null = no header). */
export type RouteProbe = (hostname: string) => Promise<string | null>;

/**
 * Routes `<project slug>.<domain>` through Traefik, with Shipyard in charge of
 * WHEN traffic moves:
 *
 * - The route table lives in ONE file, rewritten atomically (temp file + rename)
 *   on every change. Traefik watches the directory and reloads it. A rename is
 *   the one change Docker Desktop's file sharing reliably reports to Traefik;
 *   a plain delete is not, so routes are never removed by deleting files.
 * - After a change, Shipyard asks Traefik for the hostname until the response
 *   carries the new deployment's id (X-Shipyard-Deployment). Only then has
 *   traffic really moved, so only then may the old container stop.
 * - The table is derived from the database (sync() at startup), never the
 *   other way round. The file is JSON, which is valid YAML and needs no
 *   escaping rules of our own.
 *
 * Traefik never needs the Docker socket: it only reads this file.
 */
export class TraefikRouter implements Router {
  readonly network: string;
  private readonly routes = new Map<string, RouteTarget>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: TraefikRouterOptions,
    private readonly probe: RouteProbe,
    private readonly logger: Logger,
  ) {
    this.network = options.network;
  }

  urlFor(name: string): string {
    const { tls, httpPort } = this.options;
    if (tls) return `https://${this.hostname(name)}${tls.httpsPort === 443 ? "" : `:${tls.httpsPort}`}`;
    return `http://${this.hostname(name)}${httpPort === 80 ? "" : `:${httpPort}`}`;
  }

  async activate(target: RouteTarget): Promise<void> {
    assertRoutable(target);
    const previous = await this.exclusive(async () => {
      const before = this.routes.get(target.name);
      this.routes.set(target.name, target);
      await this.write();
      return before;
    });

    try {
      await this.waitUntilServed(target);
    } catch (error) {
      // Put the previous route back so whatever was live stays live.
      await this.exclusive(async () => {
        if (this.routes.get(target.name)?.deploymentId !== target.deploymentId) return;
        if (previous) this.routes.set(target.name, previous);
        else this.routes.delete(target.name);
        await this.write();
      }).catch((revertError: unknown) => this.logger.error({ err: revertError }, "Could not restore the previous route"));
      throw error;
    }
  }

  async deactivate(name: string, deploymentId: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.routes.get(name)?.deploymentId !== deploymentId) return;
      this.routes.delete(name);
      await this.write();
    });
  }

  async sync(targets: readonly RouteTarget[]): Promise<void> {
    targets.forEach(assertRoutable);
    await this.exclusive(async () => {
      this.routes.clear();
      for (const target of targets) this.routes.set(target.name, target);
      await this.write();
    });
  }

  private hostname(name: string): string {
    return `${name}.${this.options.domain}`;
  }

  private async waitUntilServed(target: RouteTarget): Promise<void> {
    const hostname = this.hostname(target.name);
    const deadline = Date.now() + this.options.cutoverTimeoutMs;
    let lastResult = "no answer yet";

    while (true) {
      try {
        const servedBy = await this.probe(hostname);
        if (servedBy === target.deploymentId) return;
        lastResult = servedBy === null ? "Traefik has no route for it yet" : `still served by deployment ${servedBy}`;
      } catch (error) {
        lastResult = describeProbeError(error);
      }

      if (Date.now() + this.options.probeIntervalMs >= deadline) {
        throw new AppError(
          ErrorCode.ROUTING_FAILED,
          `Traefik did not start sending ${hostname} to this deployment within ${Math.round(this.options.cutoverTimeoutMs / 1000)}s ` +
            `(last result: ${lastResult}). Is Traefik running? Start it with \`npm run db:up\`.`,
          { statusCode: 422 },
        );
      }
      await sleep(this.options.probeIntervalMs);
    }
  }

  /** Writes the whole table; Traefik never sees a half-written file. */
  private async write(): Promise<void> {
    const file = path.join(this.options.routesDir, ROUTES_FILE);
    const temporary = path.join(this.options.routesDir, `.${ROUTES_FILE}.${process.pid}.tmp`);
    const routes = [...this.routes.values()];
    await fs.mkdir(this.options.routesDir, { recursive: true });
    const config = traefikConfig(routes, this.options.domain, Boolean(this.options.tls));
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`);
    await fs.rename(temporary, file);
    this.logger.debug({ routes: routes.map((route) => route.name) }, "Route table written");
  }

  /** Runs route table changes one at a time, so concurrent deploys can't lose each other's routes. */
  private exclusive<T>(change: () => Promise<T>): Promise<T> {
    const result = this.queue.then(change, change);
    this.queue = result.catch(() => {});
    return result;
  }
}

/** Traefik dynamic configuration for a set of routes. Pure, so it can be tested on its own. */
export function traefikConfig(routes: readonly RouteTarget[], domain: string, tls = false): TraefikDynamicConfig {
  // Traefik ignores a configuration whose sections are all empty (the last routes would
  // stay live), but applies a file without sections.
  if (routes.length === 0) return {};

  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const middlewares: Record<string, unknown> = {};

  for (const route of [...routes].sort((a, b) => a.name.localeCompare(b.name))) {
    const id = `shipyard-${route.name}`;
    const hostnames = [`${route.name}.${domain}`, ...(route.aliases ?? [])];
    routers[id] = {
      rule: hostnames.map((hostname) => `Host(\`${hostname}\`)`).join(" || "),
      entryPoints: [tls ? TLS_ENTRY_POINT : ENTRY_POINT],
      service: id,
      middlewares: [id],
      // One certificate per hostname, requested from Let's Encrypt on first use.
      ...(tls && { tls: { certResolver: CERT_RESOLVER } }),
    };
    const urls = route.servers?.length
      ? route.servers
      : [route.containerName, ...(route.replicaContainers ?? [])].map((container) => `http://${container}:${route.containerPort}`);
    services[id] = {
      loadBalancer: {
        servers: urls.map((url) => ({ url })),
        // Several replicas: Traefik checks each and sends traffic only to those answering 2xx/3xx.
        ...(urls.length > 1 &&
          route.healthCheck && {
            healthCheck: {
              path: route.healthCheck.path,
              ...(route.healthCheck.port !== null && { port: route.healthCheck.port }),
              interval: "2s",
              timeout: "2s",
            },
          }),
      },
    };
    middlewares[id] = { headers: { customResponseHeaders: { [DEPLOYMENT_HEADER]: route.deploymentId } } };
  }
  return { http: { routers, services, middlewares } };
}

export interface TraefikDynamicConfig {
  http?: {
    routers: Record<string, unknown>;
    services: Record<string, unknown>;
    middlewares: Record<string, unknown>;
  };
}

/**
 * Probes Traefik on this host, as a visitor of `hostname` would reach it.
 * node:http rather than fetch(): fetch does not let callers set the Host header.
 */
export function createTraefikProbe(port: number, requestTimeoutMs: number, tls = false): RouteProbe {
  return (hostname) =>
    new Promise((resolve, reject) => {
      const get = tls ? https.get : http.get;
      const request = get(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          headers: { host: hostname },
          agent: false,
          timeout: requestTimeoutMs,
          // Over TLS: present the right name (SNI). The certificate itself isn't checked: this is a loopback
          // probe for the routing header, and a new hostname's certificate may still be being issued.
          ...(tls && { servername: hostname, rejectUnauthorized: false }),
        },
        (response) => {
          const servedBy = response.headers[DEPLOYMENT_HEADER.toLowerCase()];
          response.destroy(); // only the headers matter; don't wait for (or keep) the body
          resolve(typeof servedBy === "string" ? servedBy : null);
        },
      );
      request.on("timeout", () => request.destroy(new Error(`no response within ${requestTimeoutMs}ms`)));
      request.on("error", reject);
    });
}

/** Everything in a route ends up in Traefik's config: refuse anything unexpected. */
function assertRoutable(target: RouteTarget): void {
  const valid =
    DNS_LABEL.test(target.name) &&
    (target.aliases ?? []).every(isValidHostname) &&
    DEPLOYMENT_ID.test(target.deploymentId) &&
    DNS_LABEL.test(target.containerName) && // Traefik resolves it through Docker's DNS
    (target.replicaContainers ?? []).every((name) => DNS_LABEL.test(name)) &&
    (target.servers ?? []).every((url) => SERVER_URL.test(url)) &&
    (!target.healthCheck ||
      (/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(target.healthCheck.path) &&
        (target.healthCheck.port === null || (Number.isInteger(target.healthCheck.port) && target.healthCheck.port > 0 && target.healthCheck.port <= 65535)))) &&
    Number.isInteger(target.containerPort) &&
    target.containerPort > 0 &&
    target.containerPort <= 65535;
  if (!valid) {
    throw new AppError(ErrorCode.ROUTING_FAILED, `Refusing to route an invalid target: ${JSON.stringify(target)}`);
  }
}

function describeProbeError(error: unknown): string {
  return (error as { code?: string } | null)?.code ?? errorMessage(error);
}
