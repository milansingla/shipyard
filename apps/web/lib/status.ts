import type { Deployment, DeploymentStatus } from "./types";

/** The pipeline a deployment climbs, bottom to top on the draft-mark scale. */
export const PIPELINE = ["PENDING", "CLONING", "BUILDING", "STARTING", "HEALTHY", "RUNNING"] as const;
export type PipelineStage = (typeof PIPELINE)[number];

/**
 * live    — serving traffic
 * working — something is happening; keep polling
 * failed  — stopped with an error
 * idle    — stopped on purpose
 */
export type Tone = "live" | "working" | "failed" | "idle";

interface StatusInfo {
  label: string;
  tone: Tone;
}

const STATUS: Record<DeploymentStatus, StatusInfo> = {
  PENDING: { label: "Queued", tone: "working" },
  CLONING: { label: "Cloning", tone: "working" },
  BUILDING: { label: "Building", tone: "working" },
  STARTING: { label: "Starting", tone: "working" },
  HEALTHY: { label: "Health check passed", tone: "working" },
  RUNNING: { label: "Running", tone: "live" },
  FAILED: { label: "Failed", tone: "failed" },
  STOPPING: { label: "Stopping", tone: "working" },
  STOPPED: { label: "Stopped", tone: "idle" },
};

export const STAGE_LABEL: Record<PipelineStage, string> = {
  PENDING: "Queued",
  CLONING: "Clone",
  BUILDING: "Build",
  STARTING: "Start",
  HEALTHY: "Health check",
  RUNNING: "Live",
};

export function statusInfo(status: DeploymentStatus): StatusInfo {
  return STATUS[status];
}

/** While true, the dashboard polls for changes. */
export function isInProgress(status: DeploymentStatus): boolean {
  return STATUS[status].tone === "working";
}

export interface StageProgress {
  /** Index in PIPELINE of the highest stage reached (the waterline). */
  reached: number;
  /** Index of the stage that failed, if the deployment failed. */
  failedAt: number | null;
}

/**
 * Where the waterline sits for a deployment.
 *
 * The API stores the current status, not which stage a FAILED deployment
 * failed in, so that is inferred from what the deployment had produced:
 * a container → it failed while starting/health-checking; a commit → it was
 * cloned, so it failed in detection or the build; neither → during the clone.
 */
export function stageProgress(deployment: Pick<Deployment, "status" | "commitSha" | "containerId">): StageProgress {
  const { status } = deployment;
  const index = PIPELINE.indexOf(status as PipelineStage);
  if (index !== -1) return { reached: index, failedAt: null };

  if (status === "FAILED") {
    const failedAt = deployment.containerId
      ? PIPELINE.indexOf("STARTING")
      : deployment.commitSha
        ? PIPELINE.indexOf("BUILDING")
        : PIPELINE.indexOf("CLONING");
    return { reached: failedAt - 1, failedAt };
  }
  // STOPPING / STOPPED: it went all the way before being stopped.
  return { reached: PIPELINE.length - 1, failedAt: null };
}
