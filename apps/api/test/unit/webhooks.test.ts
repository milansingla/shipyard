import { describe, expect, it } from "vitest";

import { parsePushEvent } from "../../src/modules/webhooks/pushEvent.js";
import { signGitHubPayload, verifyGitHubSignature } from "../../src/modules/webhooks/signature.js";

const SECRET = "a-webhook-secret-of-sufficient-length";

describe("verifyGitHubSignature", () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');

  it("accepts GitHub's sha256 HMAC of the exact bytes", () => {
    expect(verifyGitHubSignature(SECRET, body, signGitHubPayload(SECRET, body))).toBe(true);
  });

  it("matches GitHub's documented example", () => {
    // From docs.github.com, "Validating webhook deliveries".
    expect(
      verifyGitHubSignature(
        "It's a Secret to Everybody",
        Buffer.from("Hello, World!"),
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["the old sha1 header format", "sha1=0123"],
    ["another secret", signGitHubPayload("some-other-secret-value!", body)],
    ["a different body", signGitHubPayload(SECRET, '{"zen":"tampered"}')],
    ["a truncated signature", signGitHubPayload(SECRET, body).slice(0, 30)],
    ["non-hex garbage", "sha256=zzzz"],
  ])("rejects %s", (_case, header) => {
    expect(verifyGitHubSignature(SECRET, body, header)).toBe(false);
  });

  it("rejects re-serialized JSON (the signature covers raw bytes)", () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyGitHubSignature(SECRET, pretty, signGitHubPayload(SECRET, body))).toBe(false);
  });
});

describe("parsePushEvent", () => {
  const push = (overrides: Record<string, unknown> = {}) => ({
    ref: "refs/heads/main",
    after: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
    deleted: false,
    repository: { name: "hello", owner: { login: "octocat", name: "octocat" } },
    ...overrides,
  });

  it("targets the pushed repository and branch", () => {
    expect(parsePushEvent(push())).toEqual({
      kind: "deploy",
      target: { owner: "octocat", name: "hello", branch: "main", commitSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" },
    });
  });

  it("keeps slashes in branch names", () => {
    expect(parsePushEvent(push({ ref: "refs/heads/release/v2" }))).toMatchObject({ target: { branch: "release/v2" } });
  });

  it.each([
    ["a tag", { ref: "refs/tags/v1.0.0" }, "not a branch"],
    ["a deleted branch", { deleted: true }, "branch deleted"],
    ["a zero sha", { after: "0".repeat(40) }, "branch deleted"],
  ])("ignores %s", (_case, overrides, reason) => {
    expect(parsePushEvent(push(overrides))).toEqual({ kind: "ignore", reason: expect.stringContaining(reason) });
  });

  it("ignores payloads it doesn't recognise", () => {
    expect(parsePushEvent({ action: "opened" }).kind).toBe("ignore");
    expect(parsePushEvent(null).kind).toBe("ignore");
  });
});
