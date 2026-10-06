import dns from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import { AppError, ErrorCode, ValidationError } from "../../lib/errors.js";

/** What is sent about an alert, whatever the channel. */
export interface Notification {
  kind: string;
  severity: "WARNING" | "CRITICAL";
  status: "OPEN" | "RESOLVED";
  title: string;
  message: string;
  project: { id: string; name: string } | null;
  /** Where to look, in the dashboard. */
  url: string | null;
  at: string;
}

/** A way to deliver notifications. Alerting logic never knows which one it uses. */
export interface NotificationProvider {
  send(url: string, notification: Notification): Promise<void>;
}

const TIMEOUT_MS = 5_000;

/** POSTs the notification as JSON. */
export class WebhookProvider implements NotificationProvider {
  constructor(private readonly guard: UrlGuard) {}

  async send(url: string, notification: Notification): Promise<void> {
    await this.guard.check(url);
    await post(url, notification, this.guard);
  }
}

/** A Slack incoming webhook: one formatted line. */
export class SlackProvider implements NotificationProvider {
  constructor(private readonly guard: UrlGuard) {}

  async send(url: string, notification: Notification): Promise<void> {
    await this.guard.check(url);
    const icon = notification.status === "RESOLVED" ? ":white_check_mark:" : notification.severity === "CRITICAL" ? ":rotating_light:" : ":warning:";
    const prefix = notification.status === "RESOLVED" ? "Resolved: " : "";
    const link = notification.url ? ` <${notification.url}|Open in Shipyard>` : "";
    await post(url, { text: `${icon} *${prefix}${escapeSlack(notification.title)}*: ${escapeSlack(notification.message)}${link}` }, this.guard);
  }
}

/** POSTs JSON. Redirects aren't followed (one could point anywhere, including inside the network). */
async function post(url: string, body: unknown, guard: UrlGuard): Promise<void> {
  const target = new URL(url);
  const payload = JSON.stringify(body);
  let status: number;
  try {
    status = await new Promise<number>((resolve, reject) => {
      const request = (target.protocol === "https:" ? https : http).request(
        target,
        {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "user-agent": "Shipyard-Alerts" },
          lookup: guard.connectLookup(),
          timeout: TIMEOUT_MS,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("timeout", () => request.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000}s`)));
      request.on("error", reject);
      request.end(payload);
    });
  } catch (error) {
    throw new AppError(ErrorCode.NOTIFICATION_FAILED, `Could not reach the channel: ${(error as Error).message}`, { statusCode: 422 });
  }
  if (status < 200 || status >= 300) throw new AppError(ErrorCode.NOTIFICATION_FAILED, `The channel answered ${status}.`, { statusCode: 422 });
}

/**
 * Notification URLs are typed in by users, and Shipyard requests them from
 * inside the network: without a check, a "webhook" could probe the
 * database, cloud metadata (169.254.169.254) or anything on localhost.
 * So: HTTPS only, and the host must resolve to public addresses only.
 * (SHIPYARD_ALLOW_PRIVATE_WEBHOOKS=true lifts this, for local development.)
 */
export class UrlGuard {
  constructor(private readonly allowPrivate: boolean) {}

  /** Syntax only, without DNS: for validating input. Returns the host. */
  parse(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ValidationError("Not a valid URL.");
    }
    if (url.protocol !== "https:" && !(this.allowPrivate && url.protocol === "http:")) throw new ValidationError("The URL must use https.");
    if (url.username || url.password) throw new ValidationError("The URL must not contain credentials.");
    return url.hostname;
  }

  async check(raw: string): Promise<void> {
    const host = this.parse(raw);
    if (this.allowPrivate) return;
    const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (addresses.length === 0) throw new ValidationError(`${host} doesn't resolve.`);
    const blocked = addresses.find(({ address }) => isPrivateAddress(address));
    if (blocked) throw new ValidationError(`${host} points into a private network (${blocked.address}); Shipyard only sends to public addresses.`);
  }

  /**
   * The DNS lookup the request itself connects with, refusing private
   * addresses. check() alone isn't enough: a host can answer with a public
   * address for the check and a private one for the request (DNS rebinding).
   * Checking at connect time means the address checked is the address used.
   */
  connectLookup(): typeof dns.lookup | undefined {
    if (this.allowPrivate) return undefined;
    const guarded = (hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
      dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        const blocked = addresses.find(({ address }) => isPrivateAddress(address));
        if (blocked) return callback(new Error(`${hostname} points into a private network (${blocked.address})`));
        if (addresses.length === 0) return callback(new Error(`${hostname} doesn't resolve`));
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      });
    };
    return guarded as unknown as typeof dns.lookup;
  }
}

/** Loopback, private, link-local, CGNAT, unique-local and unspecified addresses (v4, v6, v4-mapped). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const lower = address.toLowerCase();
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
