import { describe, expect, it } from "vitest";

import { duration, relativeTime, safeHttpUrl, shortId, shortSha } from "@/lib/format";

const NOW = new Date("2026-10-05T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe("format", () => {
  it("shortens SHAs and ids", () => {
    expect(shortSha("7fd1a60b01f91b314f59955a4e4d4e80d8edf11d")).toBe("7fd1a60");
    expect(shortSha(null)).toBe("—");
    expect(shortId("3f2a9c1e-77b4-4d0e-9a11-5c6d7e8f9012")).toBe("3f2a9c1");
  });

  it.each([
    [10, "just now"],
    [120, "2 minutes ago"],
    [3 * 3600, "3 hours ago"],
    [86_400, "yesterday"],
    [3 * 86_400, "3 days ago"],
  ])("%is ago → %s", (seconds, text) => {
    expect(relativeTime(ago(seconds), NOW)).toBe(text);
  });

  it.each([
    [ago(48), NOW.toISOString(), "48s"],
    [ago(185), NOW.toISOString(), "3m 05s"],
    [ago(3720), NOW.toISOString(), "1h 02m"],
    [ago(30), null, "30s"],
    [null, null, "—"],
  ])("duration(%s, %s) → %s", (start, end, text) => {
    expect(duration(start, end, NOW)).toBe(text);
  });

  it("only turns http(s) URLs into links", () => {
    expect(safeHttpUrl("http://localhost:49153")).toBe("http://localhost:49153/");
    expect(safeHttpUrl("https://app.example.com/x")).toBe("https://app.example.com/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
