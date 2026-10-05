import { describe, expect, it } from "vitest";

import { parseCron, nextRun } from "../../src/lib/cron.js";

const at = (iso: string) => new Date(iso);
const next = (expression: string, after: string) => nextRun(parseCron(expression), at(after))?.toISOString() ?? null;

describe("cron schedules", () => {
  it.each([
    ["* * * * *", "2026-10-06T10:00:30Z", "2026-10-06T10:01:00.000Z"],
    ["*/15 * * * *", "2026-10-06T10:01:00Z", "2026-10-06T10:15:00.000Z"],
    ["0 0 * * *", "2026-10-06T10:00:00Z", "2026-10-07T00:00:00.000Z"],
    ["@daily", "2026-12-31T23:59:59Z", "2027-01-01T00:00:00.000Z"],
    ["@hourly", "2026-10-06T10:00:00Z", "2026-10-06T11:00:00.000Z"],
    ["30 9 * * MON-FRI", "2026-10-09T09:30:00Z", "2026-10-12T09:30:00.000Z"], // Friday → Monday
    ["0 12 1 * *", "2026-10-06T00:00:00Z", "2026-11-01T12:00:00.000Z"],
    ["0 0 29 2 *", "2026-03-01T00:00:00Z", "2028-02-29T00:00:00.000Z"], // next leap day
    ["0 0 * * 7", "2026-10-06T00:00:00Z", "2026-10-11T00:00:00.000Z"], // 7 = Sunday
    ["0 0 1-10/3 JAN,jul *", "2026-10-06T00:00:00Z", "2027-01-01T00:00:00.000Z"],
    // Both day fields restricted: either matches (the 13th, or any Friday).
    ["0 0 13 * FRI", "2026-10-06T00:00:00Z", "2026-10-09T00:00:00.000Z"],
    ["5 4 * * *", "2026-10-06T04:05:00Z", "2026-10-07T04:05:00.000Z"], // strictly after
  ])("%s after %s → %s", (expression, after, expected) => {
    expect(next(expression, after)).toBe(expected);
  });

  it("returns null for a schedule that never fires", () => {
    expect(next("0 0 31 2 *", "2026-01-01T00:00:00Z")).toBeNull();
  });

  it.each(["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "* * * * FOO", "@sometimes", "1;2 * * * *"])(
    "refuses %j",
    (expression) => {
      expect(() => parseCron(expression)).toThrow();
    },
  );
});
