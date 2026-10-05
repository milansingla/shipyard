import { describe, expect, it } from "vitest";

import { RateLimiter } from "../../src/middleware/rateLimit.js";

describe("RateLimiter", () => {
  it("allows `limit` hits per window per key, then refuses until the window resets", () => {
    let now = 1_000;
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 }, () => now);

    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.hit("a")).toMatchObject({ allowed: false, remaining: 0, resetAt: 61_000 });
    expect(limiter.hit("b").allowed).toBe(true); // keys are independent

    now = 61_000;
    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("forgets expired windows when many keys pile up", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 10 }, () => now);
    for (let i = 0; i < 10_005; i += 1) limiter.hit(`ip-${i}`);
    now = 100;
    limiter.hit("fresh"); // triggers a sweep
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBe(1);
  });
});
