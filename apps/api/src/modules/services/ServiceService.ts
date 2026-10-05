import { type Deployment, OrgRole, type PrismaClient, type Service, isUniqueViolation } from "../../db/prisma.js";
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { AccessService } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import type { CreateServiceInput, UpdateServiceInput } from "./service.schemas.js";
import { primaryServiceId, routeName } from "./serviceRules.js";

export const MAX_SERVICES_PER_PROJECT = 20;

export interface ServiceView extends Service {
  /** Owns the project's own address (<slug>.<domain>). */
  primary: boolean;
  /** First hostname label when public; null for workers and private services. */
  routeName: string | null;
  latestDeployment: Deployment | null;
}

export interface ServiceServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  deployments: Pick<DeploymentService, "deploy" | "destroyServiceDeployments">;
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

/**
 * A project's services. Reading needs VIEWER; changing them ADMIN (they
 * decide what runs and what is public); deploying one needs DEVELOPER.
 * Changes apply to the next deployment.
 */
export class ServiceService {
  constructor(private readonly deps: ServiceServiceDeps) {}

  async list(projectId: string, userId: string): Promise<ServiceView[]> {
    const project = await this.deps.access.project(projectId, userId);
    const services = await this.deps.prisma.service.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      include: { deployments: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const primaryId = primaryServiceId(services);
    return services.map(({ deployments, ...service }) => ({
      ...service,
      primary: service.id === primaryId,
      routeName: service.type === "WEB" && service.public ? routeName(project, service, primaryId) : null,
      latestDeployment: deployments[0] ?? null,
    }));
  }

  async create(projectId: string, userId: string, input: CreateServiceInput): Promise<Service> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.ADMIN);
    const { prisma } = this.deps;
    if ((await prisma.service.count({ where: { projectId } })) >= MAX_SERVICES_PER_PROJECT) {
      throw new ValidationError(`A project can have at most ${MAX_SERVICES_PER_PROJECT} services.`);
    }
    // Its address would be <name>-<slug>: that mustn't be another project's own address.
    if (await prisma.project.findUnique({ where: { slug: `${input.name}-${project.slug}` }, select: { id: true } })) {
      throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `"${input.name}" would clash with the address of another project. Choose another name.`);
    }
    let service: Service;
    try {
      service = await prisma.service.create({
        data: { projectId, ...input, public: input.type === "WORKER" ? false : (input.public ?? true) },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `This project already has a service named "${input.name}".`);
      throw error;
    }
    this.deps.logger.info({ projectId, serviceId: service.id, name: service.name }, "Service created");
    await this.deps.audit.record({ action: "SERVICE_CREATED", actorId: userId, project, metadata: { service: service.name, type: service.type } });
    return service;
  }

  async update(serviceId: string, userId: string, input: UpdateServiceInput): Promise<Service> {
    const { service, project } = await this.find(serviceId, userId, OrgRole.ADMIN);
    if (service.type === "WORKER" && input.public === true) throw new ValidationError("Workers can't be public.");
    const updated = await this.deps.prisma.service.update({ where: { id: serviceId }, data: input });
    await this.deps.audit.record({
      action: "SERVICE_CHANGED",
      actorId: userId,
      project,
      metadata: { service: service.name, settings: Object.keys(input).sort().join(",") },
    });
    return updated;
  }

  /** Removes the service with its containers, images, logs and its own variables. A project keeps at least one service. */
  async delete(serviceId: string, userId: string): Promise<void> {
    const { service, project } = await this.find(serviceId, userId, OrgRole.ADMIN);
    if ((await this.deps.prisma.service.count({ where: { projectId: project.id } })) <= 1) {
      throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "A project needs at least one service. Delete the project instead.");
    }
    await this.deps.deployments.destroyServiceDeployments(project.id, serviceId, async () => {
      await this.deps.prisma.$transaction([
        this.deps.prisma.environmentVariable.deleteMany({ where: { projectId: project.id, scope: serviceId } }),
        this.deps.prisma.service.delete({ where: { id: serviceId } }), // cascades to deployments and its domains
      ]);
    });
    await this.deps.audit.record({ action: "SERVICE_DELETED", actorId: userId, project, metadata: { service: service.name } });
  }

  /** Deploys just this service. Needs DEVELOPER. */
  async deploy(serviceId: string, userId: string): Promise<Deployment> {
    const { service } = await this.find(serviceId, userId, OrgRole.VIEWER);
    return this.deps.deployments.deploy(service.projectId, userId, undefined, { serviceIds: [serviceId] });
  }

  private async find(serviceId: string, userId: string, need: OrgRole) {
    const service = await this.deps.prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) throw new NotFoundError(`Service not found: ${serviceId}`);
    try {
      return { service, project: await this.deps.access.project(service.projectId, userId, need) };
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError(`Service not found: ${serviceId}`);
      throw error;
    }
  }
}
