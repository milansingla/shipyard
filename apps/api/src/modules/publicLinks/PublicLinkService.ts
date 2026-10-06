import { OrgRole, type PrismaClient } from "../../db/prisma.js";
import { AppError, ErrorCode } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { TunnelRunner, TunnelState } from "../../services/tunnel/CloudflareTunnel.js";
import type { AccessService } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";

export interface PublicLinkView {
  /** Public links work here (routing through Traefik is on). */
  available: boolean;
  enabled: boolean;
  /** absent = off; starting = Cloudflare is assigning the address; live = it works; failed = see detail. */
  state: TunnelState;
  url: string | null;
  detail: string | null;
}

export interface PublicLinkServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  audit: Pick<AuditService, "record">;
  /** null when routing is off: there is no Traefik for a tunnel to reach. */
  tunnel: TunnelRunner | null;
  /** SHIPYARD_PUBLIC_DOMAIN: the project is served at <slug>.<domain>. */
  publicDomain: string | null;
  logger: Logger;
}

/**
 * A free public HTTPS address for a project's live app, with no domain to
 * buy and nothing to open on the router: a Cloudflare quick tunnel to the
 * project's own route. Off by default; turning it on makes the app
 * reachable by anyone with the link, so it needs ADMIN and is audited.
 */
export class PublicLinkService {
  constructor(private readonly deps: PublicLinkServiceDeps) {}

  async get(projectId: string, userId: string): Promise<PublicLinkView> {
    const project = await this.deps.access.project(projectId, userId);
    return this.view(project.id, project.publicLink);
  }

  async enable(projectId: string, userId: string): Promise<PublicLinkView> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.ADMIN);
    const { tunnel, publicDomain } = this.requireRouting();
    await tunnel.start(project.id, `${project.slug}.${publicDomain}`);
    if (!project.publicLink) {
      await this.deps.prisma.project.update({ where: { id: project.id }, data: { publicLink: true } });
      await this.deps.audit.record({ action: "PUBLIC_LINK_ENABLED", actorId: userId, project });
    }
    return this.view(project.id, true);
  }

  async disable(projectId: string, userId: string): Promise<void> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.ADMIN);
    await this.deps.tunnel?.stop(project.id);
    if (project.publicLink) {
      await this.deps.prisma.project.update({ where: { id: project.id }, data: { publicLink: false } });
      await this.deps.audit.record({ action: "PUBLIC_LINK_DISABLED", actorId: userId, project });
    }
  }

  /** A deleted project's tunnel goes with it. */
  async removeForProject(projectId: string): Promise<void> {
    await this.deps.tunnel?.stop(projectId);
  }

  /** At startup: every project with a public link gets its tunnel back if it is gone. */
  async reconcile(): Promise<void> {
    const { tunnel, publicDomain } = this.deps;
    if (!tunnel || !publicDomain) return;
    const projects = await this.deps.prisma.project.findMany({ where: { publicLink: true }, select: { id: true, slug: true } });
    for (const project of projects) {
      try {
        const status = await tunnel.status(project.id);
        if (status.state === "absent" || status.state === "failed") await tunnel.start(project.id, `${project.slug}.${publicDomain}`);
      } catch (error) {
        this.deps.logger.warn({ err: error, projectId: project.id }, "Could not restore a public link");
      }
    }
  }

  private async view(projectId: string, enabled: boolean): Promise<PublicLinkView> {
    const { tunnel, publicDomain } = this.deps;
    if (!tunnel || !publicDomain) return { available: false, enabled, state: "absent", url: null, detail: null };
    const status = await tunnel.status(projectId);
    return { available: true, enabled, ...status };
  }

  private requireRouting(): { tunnel: TunnelRunner; publicDomain: string } {
    const { tunnel, publicDomain } = this.deps;
    if (!tunnel || !publicDomain) {
      throw new AppError(
        ErrorCode.ROUTING_NOT_CONFIGURED,
        "Public links go through Traefik: set SHIPYARD_PUBLIC_DOMAIN and start it with `npm run db:up`.",
        { statusCode: 409 },
      );
    }
    return { tunnel, publicDomain };
  }
}
