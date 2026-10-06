import { describe, expect, it } from "vitest";

import { aggregate } from "../../src/modules/metrics/MetricsService.js";

const replica = (extra: Partial<Parameters<typeof aggregate>[0][number]> = {}) => ({
  running: true,
  cpuPercent: 10,
  memoryMb: 100,
  memoryLimitMb: 256,
  restartCount: 0,
  startedAt: null,
  ...extra,
});

describe("metrics aggregation", () => {
  it("sums a deployment's replicas", () => {
    expect(aggregate([replica(), replica({ cpuPercent: 25.55, memoryMb: 50.04, restartCount: 2 })])).toEqual({
      cpuPercent: 35.6,
      memoryMb: 150,
      memoryLimitMb: 512,
      restartCount: 2,
      running: 2,
    });
  });

  it("has no limit if any replica is unlimited, and counts only running replicas", () => {
    expect(aggregate([replica(), replica({ memoryLimitMb: null, running: false })])).toMatchObject({ memoryLimitMb: null, running: 1 });
  });
});
