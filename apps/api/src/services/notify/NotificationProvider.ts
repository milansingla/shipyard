import { lookup } from "node:dns/promises";
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
    await post(url, notification);
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
    await post(url, { text: `${icon} *${prefix}${escapeSlack(notification.title)}*: ${escapeSlack(notification.message)}${link}` });
  }
}

async function post(url: string, body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Shipyard-Alerts" },
      body: JSON.stringify(body),
      redirect: "error", // a redirect could point anywhere, including inside the network
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError(ErrorCode.NOTIFICATION_FAILED, `Could not reach the channel: ${(error as Error).message}`, { statusCode: 422 });
  }
  if (!response.ok) throw new AppError(ErrorCode.NOTIFICATION_FAILED, `The channel answered ${response.status}.`, { statusCode: 422 });
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
