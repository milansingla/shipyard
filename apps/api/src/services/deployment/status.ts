import { AppError, ErrorCode } from "../../lib/errors.js";

export const DeploymentStatus = {
  PENDING: "PENDING",
  CLONING: "CLONING",
  BUILDING: "BUILDING",
  STARTING: "STARTING",
  /** Container answered the health check. */
  HEALTHY: "HEALTHY",
  /** Healthy AND reachable at its URL (routing registered). */
  RUNNING: "RUNNING",
  FAILED: "FAILED",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
} as const;

export type DeploymentStatus = (typeof DeploymentStatus)[keyof typeof DeploymentStatus];

const S = DeploymentStatus;

/**
 * The only legal moves. Anything else is a bug (or a race) and is rejected
 * loudly instead of silently corrupting a deployment's history.
 */
const TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = {
  [S.PENDING]: [S.CLONING, S.FAILED],
  [S.CLONING]: [S.BUILDING, S.FAILED],
  [S.BUILDING]: [S.STARTING, S.FAILED],
  [S.STARTING]: [S.HEALTHY, S.FAILED],
  [S.HEALTHY]: [S.RUNNING, S.STOPPING, S.FAILED],
  [S.RUNNING]: [S.STOPPING, S.STARTING, S.FAILED], // RUNNING → STARTING = restart
  [S.STOPPING]: [S.STOPPED, S.FAILED],
  [S.STOPPED]: [S.STARTING], // restart a stopped deployment
  [S.FAILED]: [], // terminal: recover by redeploying (a new deployment)
};

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, `Cannot move deployment from ${from} to ${to}.`, {
      statusCode: 409,
    });
  }
}

export function isTerminal(status: DeploymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
