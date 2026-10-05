/** Where a project's traffic should go: one deployment's containers. */
export interface RouteTarget {
  /** The project's slug. Becomes the first label of its hostname, e.g. <name>.localhost. */
  name: string;
  deploymentId: string;
  /** Reached by name on the proxy's Docker network. */
  containerName: string;
  containerPort: number;
  /** Custom hostnames (e.g. app.example.com) routed to the same deployment. */
  aliases?: readonly string[];
  /** The deployment's other replicas (container names), load-balanced with `containerName`. */
  replicaContainers?: readonly string[];
  /**
   * The proxy checks each replica itself and skips those failing, so one
   * crashed replica doesn't fail a share of requests. Only set where a 2xx
   * answer is expected (an explicitly configured health path).
   */
  healthCheck?: { path: string; port: number | null };
}

/** A DNS hostname with at least two labels, lower-case: "app.example.com". No IPs, ports or wildcards. */
export function isValidHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  );
}

/**
 * Decides how visitors reach a deployment. The engine calls activate() once a
 * new container is healthy; only after it resolves is the deployment RUNNING
 * and may the previous one be stopped. That ordering is the zero-downtime
 * guarantee, whichever implementation is used.
 */
export interface Router {
  /** Docker network deployment containers must join so the proxy can reach them, or null. */
  readonly network: string | null;
  /** The URL visitors use. `hostPort` is the container's published port on this host. */
  urlFor(name: string, hostPort: number): string;
  /** Sends the route's traffic to `target`; resolves once that is really happening. */
  activate(target: RouteTarget): Promise<void>;
  /** Removes the route, but only while it still points at `deploymentId`. */
  deactivate(name: string, deploymentId: string): Promise<void>;
  /** Replaces the whole route table, e.g. from the database at startup. */
  sync(targets: readonly RouteTarget[]): Promise<void>;
}

/**
 * No proxy: each deployment is reached on its own published port, so every
 * deploy gets a new URL. Used when SHIPYARD_PUBLIC_DOMAIN is unset, and by the CLI.
 */
export class DirectPortRouter implements Router {
  readonly network = null;

  urlFor(_name: string, hostPort: number): string {
    return `http://localhost:${hostPort}`;
  }

  async activate(): Promise<void> {}

  async deactivate(): Promise<void> {}

  async sync(): Promise<void> {}
}
