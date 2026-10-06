import { describe, expect, it } from "vitest";

import { type SchedulableWorker, pickWorker } from "../../src/modules/deployments/scheduler.js";

const worker = (name: string, extra: Partial<SchedulableWorker> = {}): SchedulableWorker => ({
  id: name,
  name,
  status: "ONLINE",
  acceptsJobs: true,
  cpus: 4,
  memoryMb: 8192,
  runningJobs: 0,
  ...extra,
});

describe("scheduler", () => {
  it("prefers the least busy worker, then the one with more memory, then more CPUs", () => {
    expect(pickWorker([worker("a", { runningJobs: 1 }), worker("b")], { memoryMb: null })?.name).toBe("b");
    expect(pickWorker([worker("a"), worker("b", { memoryMb: 16384 })], { memoryMb: null })?.name).toBe("b");
    expect(pickWorker([worker("a"), worker("b", { cpus: 8 })], { memoryMb: null })?.name).toBe("b");
    expect(pickWorker([worker("b"), worker("a")], { memoryMb: null })?.name).toBe("a"); // stable on ties
  });

  it("never picks draining, offline, full, job-less or too-small workers", () => {
    expect(
      pickWorker(
        [
          worker("draining", { status: "DRAINING" }),
          worker("offline", { status: "OFFLINE" }),
          worker("full", { runningJobs: 2 }),
          worker("agentless", { acceptsJobs: false }),
          worker("small", { memoryMb: 512 }),
        ],
        { memoryMb: 1024 },
      ),
    ).toBeNull();
  });
});
