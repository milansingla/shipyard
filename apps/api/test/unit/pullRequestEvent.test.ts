import { describe, expect, it } from "vitest";

import { parsePullRequestEvent } from "../../src/modules/webhooks/pullRequestEvent.js";

const payload = (action: string, headRepo: string | null = "acme/shop") => ({
  action,
  number: 12,
  pull_request: {
    title: "Soil alerts",
    head: { ref: "feature/alerts", repo: headRepo === null ? null : { full_name: headRepo } },
    base: { ref: "main", repo: { full_name: "acme/shop" } },
  },
  repository: { name: "shop", owner: { login: "acme" } },
});

describe("pull_request events", () => {
  it.each(["opened", "reopened", "synchronize", "ready_for_review"])("%s deploys the preview", (action) => {
    expect(parsePullRequestEvent(payload(action))).toEqual({
      kind: "deploy",
      target: { owner: "acme", name: "shop", number: 12, branch: "feature/alerts", baseBranch: "main", title: "Soil alerts" },
    });
  });

  it("closed closes it, edited renames it, the rest is ignored", () => {
    expect(parsePullRequestEvent(payload("closed")).kind).toBe("close");
    expect(parsePullRequestEvent(payload("edited")).kind).toBe("retitle");
    expect(parsePullRequestEvent(payload("labeled"))).toMatchObject({ kind: "ignore" });
  });

  it("never builds a pull request from a fork (or a deleted one)", () => {
    expect(parsePullRequestEvent(payload("opened", "mallory/shop"))).toEqual({ kind: "ignore", reason: "pull requests from forks are never built" });
    expect(parsePullRequestEvent(payload("opened", null)).kind).toBe("ignore");
    expect(parsePullRequestEvent(payload("opened", "ACME/Shop")).kind).toBe("deploy"); // same repo, other casing
  });

  it("ignores payloads it doesn't recognise", () => {
    expect(parsePullRequestEvent({ action: "opened" })).toMatchObject({ kind: "ignore" });
  });
});
