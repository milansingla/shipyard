import { describe, expect, it } from "vitest";

import { interpretBuildEvent } from "../../src/services/docker/buildOutput.js";
import { demuxDockerLogs, formatLogChunks } from "../../src/services/docker/logs.js";
import {
  buildContainerName,
  buildImageName,
  isValidContainerReference,
  shortId,
  toDockerSlug,
} from "../../src/services/docker/naming.js";

const ID = "3f2a9c1e-77b4-4d0e-9a11-5c6d7e8f9012";

describe("naming", () => {
  it.each([
    ["Hello-World", "hello-world"],
    ["my.app_v2", "my-app-v2"],
    ["---", "app"],
    ["ÜBER App!!", "ber-app"],
    ["a".repeat(60), "a".repeat(40)],
  ])("toDockerSlug(%j) = %j", (input, expected) => {
    expect(toDockerSlug(input)).toBe(expected);
  });

  it("builds image and container names from repo name + deployment id", () => {
    expect(shortId(ID)).toBe("3f2a9c1e77b4");
    expect(buildImageName("Hello-World", ID)).toBe("shipyard/hello-world:3f2a9c1e77b4");
    expect(buildContainerName("Hello-World", ID)).toBe("shipyard-hello-world-3f2a9c1e77b4");
  });

  it("validates container references", () => {
    expect(isValidContainerReference("shipyard-app-123")).toBe(true);
    expect(isValidContainerReference("../etc")).toBe(false);
    expect(isValidContainerReference("-rf")).toBe(false);
    expect(isValidContainerReference("a b")).toBe(false);
  });
});

describe("interpretBuildEvent", () => {
  it("passes through build output", () => {
    expect(interpretBuildEvent({ stream: "Step 1/5 : FROM node\n" })).toEqual({ log: "Step 1/5 : FROM node\n" });
  });

  it("surfaces build failures reported as progress events", () => {
    const event = {
      error: "The command '/bin/sh -c npm ci' returned a non-zero code: 1",
      errorDetail: { code: 1, message: "The command '/bin/sh -c npm ci' returned a non-zero code: 1" },
    };
    expect(interpretBuildEvent(event)).toEqual({ error: event.errorDetail.message });
  });

  it("keeps image-pull milestones but drops byte-level progress", () => {
    expect(interpretBuildEvent({ status: "Pulling fs layer", id: "abc123", progressDetail: {} })).toEqual({
      log: "abc123: Pulling fs layer\n",
    });
    expect(interpretBuildEvent({ status: "Pulling from library/node", id: "22-alpine" })).toEqual({
      log: "22-alpine: Pulling from library/node\n",
    });
    expect(
      interpretBuildEvent({ status: "Downloading", id: "abc123", progressDetail: { current: 1024, total: 4096 } }),
    ).toEqual({});
  });

  it("ignores aux-only events", () => {
    expect(interpretBuildEvent({ aux: { ID: "sha256:abc" } })).toEqual({});
  });
});

function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("demuxDockerLogs", () => {
  it("splits multiplexed stdout/stderr frames and strips headers", () => {
    const buffer = Buffer.concat([frame(1, "listening on 3000\n"), frame(2, "warning: x\n"), frame(1, "ok ✓\n")]);
    const chunks = demuxDockerLogs(buffer);

    expect(chunks).toEqual([
      { stream: "stdout", text: "listening on 3000\n" },
      { stream: "stderr", text: "warning: x\n" },
      { stream: "stdout", text: "ok ✓\n" },
    ]);
    expect(formatLogChunks(chunks)).toBe("listening on 3000\nwarning: x\nok ✓\n");
  });

  it("treats non-multiplexed (TTY) output as plain stdout", () => {
    expect(demuxDockerLogs(Buffer.from("plain text\n"))).toEqual([{ stream: "stdout", text: "plain text\n" }]);
  });

  it("returns nothing for an empty buffer", () => {
    expect(demuxDockerLogs(Buffer.alloc(0))).toEqual([]);
  });

  it("tolerates a truncated final frame", () => {
    const full = frame(1, "complete\n");
    const truncated = frame(1, "cut off here").subarray(0, 8 + 3);
    expect(demuxDockerLogs(Buffer.concat([full, truncated]))).toEqual([
      { stream: "stdout", text: "complete\n" },
      { stream: "stdout", text: "cut" },
    ]);
  });
});
