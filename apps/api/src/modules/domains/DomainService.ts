import { type PrismaClient, isUniqueViolation } from "../../db/prisma.js";
import { AppError, ConflictError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { isValidHostname } from "../../services/routing/Router.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";

export const MAX_DOMAINS_PER_PROJECT = 20;

export interface DomainView {
  hostname: string;
  url: string;
  createdAt: Date;
}

export interface DomainServiceDeps {
  prisma: PrismaClient;
  deployments: Pick<DeploymentService, "refreshRoute">;
  /** SHIPYARD_PUBLIC_DOMAIN; null = routing off, so custom domains can't be served. */
  publicDomain: string | null;
  /** Apps are served over HTTPS (Let's Encrypt). */
  https: boolean;
  logger: Logger;
}

/**
 * Custom hostnames for a project (app.example.com), served next to its
 * generated <slug>.<domain> address. Adding or removing one updates the live
 * deployment's route right away; no redeploy is needed, since routing isn't
 * part of the container.
 *
 * Pointing DNS at this server is the user's job. Each hostname belongs to one
 * project only; the generated addresses can't be claimed.
 */
export class DomainService {
  constructor(private readonly deps: DomainServiceDeps) {}

  async list(projectId: string, ownerId: string): Promise<DomainView[]> {
    await this.assertOwner(projectId, ownerId);
    const domains = await this.deps.prisma.projectDomain.findMany({ where: { projectId }, orderBy: { hostname: "asc" } });
    return domains.map((domain) => this.view(domain));
  }

  async add(projectId: string, ownerId: string, input: string): Promise<DomainView> {
    await this.assertOwner(projectId, ownerId);
    const { publicDomain, prisma } = this.deps;
    if (!publicDomain) {
      throw new AppError(
        ErrorCode.ROUTING_NOT_CONFIGURED,
        "Custom domains are served by Traefik: set SHIPYARD_PUBLIC_DOMAIN and start it with `npm run db:up`.",
        { statusCode: 409 },
      );
    }
    const hostname = normalize(input);
    if (!isValidHostname(hostname)) {
      throw new ValidationError(`"${input}" is not a hostname like app.example.com (no scheme, port, path or wildcard).`);
    }
    if (hostname === publicDomain || hostname.endsWith(`.${publicDomain}`)) {
      throw new ValidationError(`Addresses under ${publicDomain} are Shipyard's own; each project already has one.`);
    }
    if ((await prisma.projectDomain.count({ where: { projectId } })) >= MAX_DOMAINS_PER_PROJECT) {
      throw new ValidationError(`A project can have at most ${MAX_DOMAINS_PER_PROJECT} custom domains.`);
    }

    let domain;
    try {
      domain = await prisma.projectDomain.create({ data: { projectId, hostname } });
    } catch (error) {
      // Don't reveal whose project it is.
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCode.DOMAIN_TAKEN, `${hostname} is already used by a project.`);
      throw error;
    }
    this.deps.logger.info({ projectId, hostname }, "Custom domain added");
    await this.deps.deployments.refreshRoute(projectId);
    return this.view(domain);
  }

  async remove(projectId: string, ownerId: string, input: string): Promise<void> {
    await this.assertOwner(projectId, ownerId);
    const { count } = await this.deps.prisma.projectDomain.deleteMany({ where: { projectId, hostname: normalize(input) } });
    if (count === 0) throw new NotFoundError(`Domain not found: ${input}`);
    this.deps.logger.info({ projectId, hostname: normalize(input) }, "Custom domain removed");
    await this.deps.deployments.refreshRoute(projectId);
  }

  private view(domain: { hostname: string; createdAt: Date }): DomainView {
    return {
      hostname: domain.hostname,
      url: `${this.deps.https ? "https" : "http"}://${domain.hostname}`,
      createdAt: domain.createdAt,
    };
  }

  private async assertOwner(projectId: string, ownerId: string): Promise<void> {
    const project = await this.deps.prisma.project.findFirst({ where: { id: projectId, ownerId }, select: { id: true } });
    if (!project) throw new NotFoundError(`Project not found: ${projectId}`);
  }
}

/** "App.Example.com." → "app.example.com". */
function normalize(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, "");
}
