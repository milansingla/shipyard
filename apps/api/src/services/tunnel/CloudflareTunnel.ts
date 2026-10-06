import type Docker from "dockerode";

import { AppError, ErrorCode, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { DockerService } from "../docker/DockerService.js";
import { demuxDockerLogs } from "../docker/logs.js";

/** Pinned: a new cloudflared is a deliberate upgrade, not whatever "latest" is that day. */
export const TUNNEL_IMAGE = "cloudflare/cloudflared:2026.10.0";
/** On every tunnel container; nothing else in Shipyard looks for it, so cleanup never touches one. */
export const TUNNEL_LABEL = "shipyard.tunnel.project-id";

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
const LOG_TAIL = 300;

export type TunnelState = "absent" | "starting" | "live" | "failed";

export interface TunnelStatus {
  state: TunnelState;
  /** https://<words>.trycloudflare.com once Cloudflare has assigned it. */
  url: string | null;
  /** Why it isn't live, when it failed: cloudflared's own last error lines. */
  detail: string | null;
}

/** Starts, inspects and stops one project's public tunnel. */
export interface TunnelRunner {
  /** Starts the tunnel, replacing any earlier one (a new random URL). */
  start(projectId: string, hostHeader: string): Promise<void>;
  stop(projectId: string): Promise<void>;
  status(projectId: string): Promise<TunnelStatus>;
}

export interface CloudflareTunnelOptions {
  /** Docker network shared with Traefik (shipyard-edge). */
  network: string;
  /** Traefik serves apps over HTTPS (production): the tunnel then reaches its HTTPS entry point. */
  tls: boolean;
  /** Traefik's name on that network; default TRAEFIK_CONTAINER. */
  traefikHost?: string;
}

/** Traefik's container on the edge network (container_name in docker-compose.yml). */
export const TRAEFIK_CONTAINER = "shipyard-traefik";

/**
 * A Cloudflare quick tunnel per project: a cloudflared container on the edge
 * network that forwards https://<random>.trycloudflare.com to Traefik with
 * the project's own hostname, so it always reaches the live deployment
 * (redeploys and rollbacks included). Outbound-only: nothing on this machine
 * is opened to the internet, and it needs no Cloudflare account. Quick
 * tunnels are for sharing and testing: the URL is random and changes when
 * the tunnel restarts.
 */
export class CloudflareTunnel implements TunnelRunner {
  constructor(
    private readonly docker: Docker,
    private readonly images: Pick<DockerService, "ensureImage">,
    private readonly options: CloudflareTunnelOptions,
    private readonly logger: Logger,
  ) {}

  private get traefikHost(): string {
    return this.options.traefikHost ?? TRAEFIK_CONTAINER;
  }

  async start(projectId: string, hostHeader: string): Promise<void> {
    if (!/^[a-z0-9.-]{1,253}$/.test(hostHeader)) throw new RangeError(`Invalid host header: ${hostHeader}`);
    await this.stop(projectId);
    await this.images.ensureImage(TUNNEL_IMAGE, (text) => this.logger.debug({ projectId }, text.trim()));
    try {
      const container = await this.docker.createContainer({
        name: containerName(projectId),
        Image: TUNNEL_IMAGE,
        Cmd: this.options.tls
          ? // Plain HTTP only redirects there; HTTPS with the app's name, inside the private edge network.
            ["tunnel", "--url", `https://${this.traefikHost}:443`, "--http-host-header", hostHeader, "--origin-server-name", hostHeader, "--no-tls-verify"]
          : ["tunnel", "--url", `http://${this.traefikHost}:80`, "--http-host-header", hostHeader],
        Labels: { [TUNNEL_LABEL]: projectId },
        HostConfig: {
          NetworkMode: this.options.network,
          // Back after a Docker restart; it gets a new URL then, which status() reads from its log.
          RestartPolicy: { Name: "unless-stopped" },
          Memory: 128 * 1024 * 1024,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
        },
      });
      await container.start();
    } catch (error) {
      throw new AppError(ErrorCode.CONTAINER_START_FAILED, `Could not start the public link: ${errorMessage(error)}`, { statusCode: 502, cause: error });
    }
    this.logger.info({ projectId, hostHeader }, "Public link tunnel started");
  }

  async stop(projectId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerName(projectId)).remove({ force: true });
      this.logger.info({ projectId }, "Public link tunnel removed");
    } catch (error) {
      if (!isNotFound(error)) throw new AppError(ErrorCode.DOCKER_UNAVAILABLE, `Could not remove the public link: ${errorMessage(error)}`, { cause: error });
    }
  }

  async status(projectId: string): Promise<TunnelStatus> {
    const container = this.docker.getContainer(containerName(projectId));
    let running: boolean;
    try {
      running = Boolean((await container.inspect()).State?.Running);
    } catch (error) {
      if (isNotFound(error)) return { state: "absent", url: null, detail: null };
      throw new AppError(ErrorCode.DOCKER_UNAVAILABLE, `Could not inspect the public link: ${errorMessage(error)}`, { cause: error });
    }
    const buffer = await container.logs({ stdout: true, stderr: true, follow: false, tail: LOG_TAIL });
    return readTunnelLog(demuxDockerLogs(buffer).map((chunk) => chunk.text).join(""), running);
  }
}

/** What cloudflared's log says: the newest URL, and whether a connection to Cloudflare is up since it was assigned. */
export function readTunnelLog(log: string, running: boolean): TunnelStatus {
  const urls = [...log.matchAll(QUICK_TUNNEL_URL)];
  const last = urls.at(-1);
  const url = last?.[0] ?? null;
  const after = last ? log.slice(last.index) : "";
  const errors = log
    .split("\n")
    .filter((line) => /\bERR\b|error/i.test(line))
    .slice(-3)
    .map((line) => line.replace(/^\S+Z\s+/, "").trim());
  if (!running) return { state: "failed", url: null, detail: errors.join("\n") || "The tunnel stopped." };
  if (url && /Registered tunnel connection/.test(after)) return { state: "live", url, detail: null };
  return { state: "starting", url, detail: null };
}

export function containerName(projectId: string): string {
  return `shipyard-tunnel-${projectId.replace(/-/g, "").slice(0, 12)}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { statusCode?: number }).statusCode === 404;
}
