import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/errors.js";
import { BuildLogStore } from "../../src/modules/deployments/BuildLogStore.js";

const ID = "3f2a9c1e-77b4-4d0e-9a11-5c6d7e8f9012";

describe("BuildLogStore", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-logs-"));
  });
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("follows a log while it is written, decoding characters split across reads, and ends with the build", async () => {
    const store = new BuildLogStore(dataDir);
    const writer = await store.open(ID); // marks the build as in progress
    const file = path.join(dataDir, "logs", `${ID}.log`);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 40));

    let received = "";
    const done = store.follow(ID, (text) => void (received += text), new AbortController().signal, 10);
    await fs.appendFile(file, "Step 1/2\n");
    await pause();
    const ship = Buffer.from("⛵");
    await fs.appendFile(file, ship.subarray(0, 1)); // half a character…
    await pause();
    await fs.appendFile(file, Buffer.concat([ship.subarray(1), Buffer.from(" Step 2/2\n")]));
    await pause();
    expect(received).toBe("Step 1/2\n⛵ Step 2/2\n");

    await writer.close();
    await done; // ends because the build ended
  });

  it("follow() of a finished build sends the whole log and ends; a missing one ends empty", async () => {
    const store = new BuildLogStore(dataDir);
    const writer = await store.open(ID);
    writer.write("all done\n");
    await writer.close();

    let received = "";
    await store.follow(ID, (text) => void (received += text), new AbortController().signal, 10);
    expect(received).toBe("all done\n");

    let nothing = "";
    await store.follow("00000000-0000-4000-8000-000000000000", (text) => void (nothing += text), new AbortController().signal, 10);
    expect(nothing).toBe("");
  });

  it("stops following when the client goes away", async () => {
    const store = new BuildLogStore(dataDir);
    const writer = await store.open(ID);
    const abort = new AbortController();
    const done = store.follow(ID, () => {}, abort.signal, 10);
    abort.abort();
    await expect(done).resolves.toBeUndefined();
    await writer.close();
  });

  it("writes, reads back and removes a log", async () => {
    const store = new BuildLogStore(dataDir);
    const writer = await store.open(ID);
    writer.write("Step 1/3 : FROM node\n");
    writer.write("Successfully built\n");
    await writer.close();

    expect(await store.read(ID)).toBe("Step 1/3 : FROM node\nSuccessfully built\n");
    await store.remove(ID);
    expect(await store.read(ID)).toBe("");
  });

  it("returns an empty string for a deployment without a log", async () => {
    expect(await new BuildLogStore(dataDir).read(ID)).toBe("");
  });

  it("keeps the END of an oversized log (where the error is)", async () => {
    const store = new BuildLogStore(dataDir, 30, 1_000);
    const writer = await store.open(ID);
    writer.write("x".repeat(100));
    writer.write("\nERROR: npm ci failed\n");
    await writer.close();

    const content = await store.read(ID);
    expect(content).toMatch(/^\[shipyard\] Showing the last 30 bytes of 122\.\n/);
    expect(content.endsWith("ERROR: npm ci failed\n")).toBe(true);
  });

  it("stops writing at the hard limit so a runaway build can't fill the disk", async () => {
    const store = new BuildLogStore(dataDir, 1_000, 50);
    const writer = await store.open(ID);
    for (let i = 0; i < 100; i++) writer.write("0123456789");
    await writer.close();

    const content = await store.read(ID);
    expect(content).toContain("Log exceeded 50 bytes");
    expect(content.length).toBeLessThan(200);
  });

  it("refuses ids that are not UUIDs (path traversal)", async () => {
    const store = new BuildLogStore(dataDir);
    await expect(store.read("../../etc/passwd")).rejects.toThrow(AppError);
  });
});
