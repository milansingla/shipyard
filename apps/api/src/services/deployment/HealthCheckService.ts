import { setTimeout as sleep } from "node:timers/promises";

import { AppError, ErrorCode, errorMessage } from "../../lib/errors.js";
import type { ContainerState } from "../docker/DockerService.js";

export interface HealthCheckOptions {
  timeoutMs: number;
  intervalMs: number;
  requestTimeoutMs: number;
}

export interface HealthCheckTarget {
  url: string;
  /** Lets the checker fail fast when the process has already crashed. */
  getContainerState: () => Promise<ContainerState>;
}

export interface HealthCheckResult {
  statusCode: number;
  attempts: number;
  durationMs: number;
}

/**
 * "Container is running" ≠ "application is healthy". A container can be up
 * while the app is still booting, crash-looping, or listening on the wrong port.
 *
 * Rule (V2): the app is healthy once it answers HTTP on its port with any
 * status below 500. A 404 still proves the server is up and listening — many
 * APIs have no route at "/". A 5xx or a refused connection does not.
 */
export class HealthCheckService {
  constructor(
    private readonly options: HealthCheckOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async waitUntilHealthy(target: HealthCheckTarget): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    const deadline = startedAt + this.options.timeoutMs;
    let attempts = 0;
    let lastProblem = "no response yet";

    while (true) {
      const state = await target.getContainerState();
      if (!state.running) {
        throw new AppError(
          ErrorCode.HEALTH_CHECK_FAILED,
          `Container exited${state.exitCode === null ? "" : ` with code ${state.exitCode}`} before becoming healthy.`,
          { statusCode: 422 },
        );
      }

      attempts += 1;
      try {
        const response = await this.fetchImpl(target.url, {
          redirect: "manual",
          signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        });
        await response.body?.cancel(); // free the socket; we only care about the status
        if (response.status < 500) {
          return { statusCode: response.status, attempts, durationMs: Date.now() - startedAt };
        }
        lastProblem = `HTTP ${response.status}`;
      } catch (error) {
        lastProblem = describeFetchError(error);
      }

      if (Date.now() + this.options.intervalMs >= deadline) {
        throw new AppError(
          ErrorCode.HEALTH_CHECK_FAILED,
          `Application did not become healthy within ${this.options.timeoutMs}ms at ${target.url} (last result: ${lastProblem}). ` +
            "Check that the app listens on 0.0.0.0 and on the port Shipyard passes via $PORT.",
          { statusCode: 422 },
        );
      }
      await sleep(this.options.intervalMs);
    }
  }
}

function describeFetchError(error: unknown): string {
  // undici wraps the useful reason (ECONNREFUSED, ECONNRESET, …) in `cause`.
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  return cause?.code ?? errorMessage(error);
}
