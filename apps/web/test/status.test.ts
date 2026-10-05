import { describe, expect, it } from "vitest";

import { PIPELINE, isInProgress, stageProgress, statusInfo } from "@/lib/status";
import type { DeploymentStatus } from "@/lib/types";

const ALL: DeploymentStatus[] = ["PENDING", "CLONING", "BUILDING", "STARTING", "HEALTHY", "RUNNING", "FAILED", "STOPPING", "STOPPED"];

describe("status model", () => {
  it("covers every API status, with a tone that drives polling", () => {
    expect(ALL.filter(isInProgress)).toEqual(["PENDING", "CLONING", "BUILDING", "STARTING", "HEALTHY", "STOPPING"]);
    expect(statusInfo("RUNNING").tone).toBe("live");
    expect(statusInfo("FAILED").tone).toBe("failed");
    expect(statusInfo("STOPPED").tone).toBe("idle");
  });

  it.each(PIPELINE.map((stage, index) => [stage, index] as const))("%s puts the waterline at stage %i", (status, index) => {
    expect(stageProgress({ status, commitSha: null, containerId: null })).toEqual({ reached: index, failedAt: null });
  });

  it.each([
    ["no commit → failed while cloning", null, null, "CLONING"],
    ["commit, no container → failed in detection/build", "abc", null, "BUILDING"],
    ["container → failed while starting / health check", "abc", "c1", "STARTING"],
  ] as const)("FAILED with %s", (_case, commitSha, containerId, stage) => {
    const failedAt = PIPELINE.indexOf(stage);
    expect(stageProgress({ status: "FAILED", commitSha, containerId })).toEqual({ reached: failedAt - 1, failedAt });
  });

  it("a stopped deployment had reached the top", () => {
    expect(stageProgress({ status: "STOPPED", commitSha: "a", containerId: "c" }).reached).toBe(PIPELINE.length - 1);
  });
});
