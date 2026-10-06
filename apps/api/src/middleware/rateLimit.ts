import type { Request, RequestHandler } from "express";

import { AppError, ErrorCode } from "../lib/errors.js";

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter per key: at most `limit` hits per `windowMs`.
 * In memory, so it is per API process — fine for one Shipyard server; several
 * would share a store (PostgreSQL or Redis) instead.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  /** The rule is read on every hit, so a configuration change applies to the next window. */
  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = this.now();
    const { limit, windowMs } = this.rule;
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      if (this.windows.size > 10_000) this.sweep(now); // bounded memory under a flood of distinct keys
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return { allowed: window.count <= limit, remaining: Math.max(0, limit - window.count), resetAt: window.resetAt };
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

/**
 * Express middleware around a RateLimiter. `key` returns null to skip a
 * request (e.g. not the kind of request this rule is about). Sends the
 * standard RateLimit-* headers, and Retry-After with a 429.
 */
export function rateLimit(name: string, rule: RateLimitRule, key: (req: Request) => string | null): RequestHandler {
  const limiter = new RateLimiter(rule);
  return (req, res, next) => {
    const id = key(req);
    if (id === null) return next();
    const { allowed, remaining, resetAt } = limiter.hit(`${name}:${id}`);
    const resetSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.set({ "ratelimit-limit": String(rule.limit), "ratelimit-remaining": String(remaining), "ratelimit-reset": String(resetSeconds) });
    if (allowed) return next();
    res.set("retry-after", String(resetSeconds));
    next(
      new AppError(ErrorCode.RATE_LIMITED, `Too many requests. Try again in ${resetSeconds} seconds.`, { statusCode: 429 }),
    );
  };
}

/** Limits per rule; see docs/security.md. */
export interface RateLimits {
  signIn: RateLimitRule;
  webhooks: RateLimitRule;
  deploys: RateLimitRule;
  writes: RateLimitRule;
  reads: RateLimitRule;
  ai: RateLimitRule;
}

const MINUTE = 60_000;

export const DEFAULT_RATE_LIMITS: RateLimits = {
  /**
   * Per IP: starting or finishing a GitHub sign-in. Behind the dashboard every
   * browser shares the proxy's address unless SHIPYARD_TRUST_PROXY is set, so
   * this is generous: it stops floods, not one busy team.
   */
  signIn: { limit: 60, windowMs: MINUTE },
  /** Per IP: GitHub delivers in bursts when many repos push. */
  webhooks: { limit: 300, windowMs: MINUTE },
  /** Per user: anything that starts a build (deploy, redeploy, rollback, restart). */
  deploys: { limit: 20, windowMs: MINUTE },
  /** Per user: any other change. */
  writes: { limit: 120, windowMs: MINUTE },
  /** Per user: reads, including the dashboard's polling (~40/min per open tab). */
  reads: { limit: 1_200, windowMs: MINUTE },
  /** Per user: AI assistant requests (each one is a paid model call, some several). */
  ai: { limit: 10, windowMs: MINUTE },
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEPLOY_PATH = /\/(deploy|redeploy|rollback|restart)$/;

export function isWrite(req: Request): boolean {
  return WRITE_METHODS.has(req.method);
}

export function isDeploy(req: Request): boolean {
  return req.method === "POST" && DEPLOY_PATH.test(req.path);
}
