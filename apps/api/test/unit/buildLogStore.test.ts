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
