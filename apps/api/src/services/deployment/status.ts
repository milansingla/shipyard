import { AppError, ErrorCode } from "../../lib/errors.js";

export const DeploymentStatus = {
  /** Created; waiting for its turn to run. */
  QUEUED: "QUEUED",
  CLONING: "CLONING",
  /** Deciding how to build: the repository's Dockerfile, or one generated for it. */
  DETECTING: "DETECTING",
  BUILDING: "BUILDING",
  /** Container created and started. */
  STARTING: "STARTING",
  /** Waiting for the app to answer HTTP. A running container is not yet a working app. */
  HEALTH_CHECKING: "HEALTH_CHECKING",
  /** The app answered its health check. It does not receive traffic yet. */
  HEALTHY: "HEALTHY",
  /** Moving the project's address to this deployment; done once the proxy confirms it. */
  ROUTING: "ROUTING",
  /** Healthy AND serving the project's address. */
  RUNNING: "RUNNING",
  FAILED: "FAILED",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
  /** An earlier deployment being brought back; then health check → routing → RUNNING. */
  ROLLING_BACK: "ROLLING_BACK",
} as const;

export type DeploymentStatus = (typeof DeploymentStatus)[keyof typeof DeploymentStatus];

const S = DeploymentStatus;

/**
 * The only legal moves. Anything else is a bug (or a race) and is rejected
 * loudly instead of silently corrupting a deployment's history.
 */
const TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = {
  [S.QUEUED]: [S.CLONING, S.FAILED],
  [S.CLONING]: [S.DETECTING, S.FAILED],
  [S.DETECTING]: [S.BUILDING, S.FAILED],
  [S.BUILDING]: [S.STARTING, S.FAILED],
  [S.STARTING]: [S.HEALTH_CHECKING, S.FAILED],
  [S.HEALTH_CHECKING]: [S.HEALTHY, S.FAILED],
  [S.HEALTHY]: [S.ROUTING, S.STOPPING, S.FAILED],
  [S.ROUTING]: [S.RUNNING, S.FAILED],
  [S.RUNNING]: [S.STOPPING, S.STARTING, S.FAILED], // RUNNING → STARTING = restart
  [S.STOPPING]: [S.STOPPED, S.FAILED],
  [S.STOPPED]: [S.STARTING, S.ROLLING_BACK], // restart, or bring back as a rollback
  [S.ROLLING_BACK]: [S.HEALTH_CHECKING, S.FAILED],
  [S.FAILED]: [], // terminal: recover by redeploying (a new deployment)
};

/** Statuses during which a deployment is still being worked on. */
export const IN_PROGRESS_STATUSES: readonly DeploymentStatus[] = [
  S.QUEUED,
  S.CLONING,
  S.DETECTING,
  S.BUILDING,
  S.STARTING,
  S.HEALTH_CHECKING,
  S.HEALTHY,
  S.ROUTING,
  S.ROLLING_BACK,
];

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
