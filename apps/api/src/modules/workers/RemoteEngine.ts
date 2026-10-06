import { AppError, ErrorCode, NotFoundError } from "../../lib/errors.js";
import type { DeploymentEngine } from "../../services/deployment/DeploymentEngine.js";
import { DeploymentFailedError } from "../../services/deployment/DeploymentEngine.js";
import type { DeploymentStatus } from "../../services/deployment/status.js";
import type { DeploymentJob, DeploymentObserver, DeploymentState } from "../../services/deployment/types.js";
import type { LogChunk } from "../../services/docker/logs.js";
import type { OneOffContainerOptions, OneOffResult } from "../../services/docker/DockerService.js";
import type { RouteTarget } from "../../services/routing/Router.js";
import { RemoteCallError, type WorkerCalls } from "./WorkerCalls.js";

/** What a deploy needs from an engine; the local DeploymentEngine and RemoteEngine both provide it. */
export type EngineApi = Pick<
  DeploymentEngine,
  "run" | "stop" | "restart" | "getLogs" | "followLogs" | "destroy" | "inspect" | "ensureRoutable" | "artifactNames" | "removeNetwork" | "removeVolumes"
> & { runToCompletion(options: OneOffContainerOptions): Promise<OneOffResult> };

/** Events a worker streams back while it runs a call. */
export type WorkerEvent =
  | { type: "status"; state: DeploymentState; previous: DeploymentStatus }
  | { type: "log"; source: "system" | "build" | "runtime"; text: string }
  | { type: "stage"; status: DeploymentStatus }
  | { type: "chunk"; chunk: LogChunk }
  | { type: "route"; target: RouteTarget };

const RUN_TIMEOUT_MS = 60 * 60_000;

/**
 * The engine of a remote worker, as seen from the control plane: each method
 * becomes a call the worker performs on its own Docker. Routing stays with
 * the control plane: when the worker's engine moves traffic, it sends a
 * "route" event and `route` (the control plane's router) applies it.
 */
export class RemoteEngine implements EngineApi {
  constructor(
    private readonly workerId: string,
    private readonly calls: WorkerCalls,
    /** Image/container naming: the same rules everywhere. */
    private readonly naming: Pick<DeploymentEngine, "artifactNames">,
    private readonly route: (target: RouteTarget) => Promise<void>,
  ) {}

  artifactNames(job: Pick<DeploymentJob, "id" | "name">) {
    return this.naming.artifactNames(job);
  }

  async run(job: DeploymentJob, observer: DeploymentObserver = {}): Promise<DeploymentState> {
    try {
      const state = await this.calls.call<DeploymentState>(this.workerId, "run", { job }, {
        timeoutMs: RUN_TIMEOUT_MS,
        onEvent: async (raw) => {
          const event = raw as WorkerEvent;
          if (event.type === "status") await observer.onStatusChange?.(revive(event.state), event.previous);
          else if (event.type === "log") observer.onLog?.(event.source, event.text);
          else if (event.type === "route") await this.route(event.target);
          return null;
        },
      });
      return revive(state);
    } catch (error) {
      if (error instanceof RemoteCallError && error.detail.deployment) {
        throw new DeploymentFailedError(revive(error.detail.deployment as DeploymentState), new AppError(error.detail.code as ErrorCode, error.message));
      }
      throw local(error);
    }
  }

  async restart(
    containerReference: string,
    route: { name: string; aliases?: readonly string[] } | null,
    onStage: (status: DeploymentStatus) => Promise<void> = async () => {},
  ) {
    return this.invoke<Awaited<ReturnType<DeploymentEngine["restart"]>>>("restart", { containerReference, route }, {
      timeoutMs: 10 * 60_000,
      onEvent: async (raw) => {
        const event = raw as WorkerEvent;
        if (event.type === "stage") await onStage(event.status);
        else if (event.type === "route") await this.route(event.target);
        return null;
      },
    });
  }

  async followLogs(containerReference: string, tail: number, onChunk: (chunk: LogChunk) => void, signal: AbortSignal): Promise<void> {
    const done = this.invoke<void>("followLogs", { containerReference, tail }, {
      timeoutMs: 24 * 60 * 60_000,
      onEvent: async (raw) => {
        const event = raw as WorkerEvent;
        if (event.type === "chunk") onChunk(event.chunk);
        return null;
      },
    });
    const callId = this.calls.latest(this.workerId, "followLogs");
    signal.addEventListener("abort", () => callId && this.calls.cancel(callId), { once: true });
    await done;
  }

  stop(containerReference: string) {
    return this.invoke<Awaited<ReturnType<DeploymentEngine["stop"]>>>("stop", { containerReference });
  }

  getLogs(containerReference: string, tail?: number) {
    return this.invoke<LogChunk[]>("getLogs", { containerReference, tail });
  }

  destroy(artifacts: { deploymentId?: string; containerId: string | null; imageName: string | null }) {
    return this.invoke<void>("destroy", { artifacts });
  }

  inspect(containerReference: string) {
    return this.invoke<Awaited<ReturnType<DeploymentEngine["inspect"]>>>("inspect", { containerReference });
  }

  ensureRoutable(containerReference: string) {
    return this.invoke<void>("ensureRoutable", { containerReference });
  }

  removeNetwork(name: string) {
    return this.invoke<void>("removeNetwork", { name });
  }

  removeVolumes(names: readonly string[]) {
    return this.invoke<void>("removeVolumes", { names });
  }

  runToCompletion(options: OneOffContainerOptions) {
    return this.invoke<OneOffResult>("runToCompletion", { options }, { timeoutMs: options.timeoutMs + 60_000 });
  }

  private async invoke<T>(method: string, args: unknown, options: Parameters<WorkerCalls["call"]>[3] = {}): Promise<T> {
    try {
      return await this.calls.call<T>(this.workerId, method, args, options);
    } catch (error) {
      throw local(error);
    }
  }
}

/** Errors the rest of the control plane recognises (a missing container is a NotFoundError). */
function local(error: unknown): unknown {
  if (error instanceof RemoteCallError && error.detail.code === ErrorCode.NOT_FOUND) return new NotFoundError(error.message);
  return error;
}

/** JSON turned the state's dates into strings. */
function revive(state: DeploymentState): DeploymentState {
  return {
    ...state,
    startedAt: state.startedAt ? new Date(state.startedAt) : null,
    finishedAt: state.finishedAt ? new Date(state.finishedAt) : null,
  };
}
