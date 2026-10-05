import { describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/errors.js";
import {
  DeploymentStatus as S,
  assertTransition,
  canTransition,
  isTerminal,
} from "../../src/services/deployment/status.js";

describe("deployment status transitions", () => {
  it("allows the happy path in order", () => {
    const path = [S.PENDING, S.CLONING, S.BUILDING, S.STARTING, S.HEALTHY, S.RUNNING, S.STOPPING, S.STOPPED];
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it("allows restart from RUNNING and STOPPED", () => {
    expect(canTransition(S.RUNNING, S.STARTING)).toBe(true);
    expect(canTransition(S.STOPPED, S.STARTING)).toBe(true);
  });

  it.each([S.PENDING, S.CLONING, S.BUILDING, S.STARTING, S.HEALTHY, S.RUNNING, S.STOPPING])(
    "allows %s → FAILED",
    (from) => {
      expect(canTransition(from, S.FAILED)).toBe(true);
    },
  );

  it.each([
    [S.PENDING, S.RUNNING], // skipping the pipeline
    [S.STARTING, S.RUNNING], // skipping the health check
    [S.BUILDING, S.CLONING], // going backwards
    [S.FAILED, S.STARTING], // FAILED is terminal
    [S.STOPPED, S.FAILED],
  ])("rejects %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(AppError);
  });

  it("only FAILED is terminal", () => {
    const terminal = Object.values(S).filter(isTerminal);
    expect(terminal).toEqual([S.FAILED]);
  });
});
