import { describe, expect, it } from "vitest";

import { PIPELINE, isInProgress, stageProgress, statusInfo } from "@/lib/status";
import type { DeploymentStatus } from "@/lib/types";

const ALL: DeploymentStatus[] = [
  "QUEUED",
  "CLONING",
  "DETECTING",
  "BUILDING",
  "STARTING",
  "HEALTH_CHECKING",
  "HEALTHY",
  "ROUTING",
  "RUNNING",
  "FAILED",
  "STOPPING",
  "STOPPED",
  "ROLLING_BACK",
];

const none = { commitSha: null, containerId: null, failedStage: null };

describe("status model", () => {
  it("covers every API status, with a tone that drives polling", () => {
    expect(ALL.filter(isInProgress)).toEqual([...PIPELINE.filter((s) => s !== "RUNNING"), "STOPPING", "ROLLING_BACK"]);
    expect(statusInfo("RUNNING").tone).toBe("live");
    expect(statusInfo("FAILED").tone).toBe("failed");
    expect(statusInfo("STOPPED").tone).toBe("idle");
  });

  it.each(PIPELINE.map((stage, index) => [stage, index] as const))("%s puts the waterline at stage %i", (status, index) => {
    expect(stageProgress({ status, ...none })).toEqual({ reached: index, failedAt: null });
  });

  it("FAILED uses the recorded stage", () => {
    const failedAt = PIPELINE.indexOf("ROUTING");
    expect(stageProgress({ status: "FAILED", commitSha: "a", containerId: "c", failedStage: "ROUTING" })).toEqual({
      reached: failedAt - 1,
      failedAt,
    });
  });

  it.each([
    ["no commit → failed while cloning", null, null, "CLONING"],
    ["commit, no container → failed in detection/build", "abc", null, "BUILDING"],
    ["container → failed while starting / health check", "abc", "c1", "HEALTH_CHECKING"],
  ] as const)("FAILED before V3 (no recorded stage) with %s", (_case, commitSha, containerId, stage) => {
    const failedAt = PIPELINE.indexOf(stage);
    expect(stageProgress({ status: "FAILED", commitSha, containerId, failedStage: null })).toEqual({
      reached: failedAt - 1,
      failedAt,
    });
  });

  it("a deployment being rolled back to is starting again", () => {
    expect(stageProgress({ status: "ROLLING_BACK", commitSha: "a", containerId: "c", failedStage: null })).toEqual({
      reached: PIPELINE.indexOf("STARTING"),
      failedAt: null,
    });
  });

  it("a stopped deployment had reached the top", () => {
    expect(stageProgress({ status: "STOPPED", commitSha: "a", containerId: "c", failedStage: null }).reached).toBe(
      PIPELINE.length - 1,
    );
  });
});
