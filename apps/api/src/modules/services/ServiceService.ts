import { type Deployment, OrgRole, type PrismaClient, type Service, type Volume, isUniqueViolation } from "../../db/prisma.js";
import { AppError, ConflictError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { AccessService } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import type { EnvironmentService } from "../environment/EnvironmentService.js";
import { POSTGRES_PORT, POSTGRES_USER } from "./postgres.js";
import { provisionPostgres } from "./PostgresProvisioner.js";
import { type CreateDatabaseInput, type CreateServiceInput, type UpdateServiceInput, updateDatabaseSchema } from "./service.schemas.js";
import { primaryServiceId, routeName } from "./serviceRules.js";

export const MAX_SERVICES_PER_PROJECT = 20;

export function secretKeyNeeded(): AppError {
  return new AppError(ErrorCode.CONFIG_INVALID, "Databases need SHIPYARD_SECRET_KEY: their password is stored encrypted. Set it and restart Shipyard.", {
    statusCode: 422,
  });
}

/** Deleting persistent data is never implied. */
export function volumesExist(names: readonly string[]): ConflictError {
  return new ConflictError(
    ErrorCode.VOLUMES_EXIST,
    `This would delete the data in ${names.join(", ")} for good. To do that, ask again with deleteData=true.`,
  );
}

export interface ServiceView extends Service {
  /** Owns the project's own address (<slug>.<domain>). */
  primary: boolean;
  /** First hostname label when public; null for workers and private services. */
  routeName: string | null;
  latestDeployment: Deployment | null;
  volumes: Volume[];
}

export interface ServiceServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  deployments: Pick<DeploymentService, "deploy" | "destroyServiceDeployments" | "removeVolumes">;
  audit: Pick<AuditService, "record">;
  /** null without SHIPYARD_SECRET_KEY: then databases can't be added (their password must be encrypted). */
  environment: Pick<EnvironmentService, "sealedRows" | "forDeployment"> | null;
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
      include: { deployments: { orderBy: { createdAt: "desc" }, take: 1 }, volumes: { orderBy: { createdAt: "asc" } } },
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
    await this.assertRoomFor(project, input.name);
    const { prisma } = this.deps;
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

  /**
   * Adds a PostgreSQL service with its data volume, a generated password, and
   * the URL the project's other services connect with (DATABASE_URL, or
   * <NAME>_DATABASE_URL if taken). It starts on the next deploy.
   */
  async createDatabase(projectId: string, userId: string, input: CreateDatabaseInput): Promise<Service & { connectionVariable: string }> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.ADMIN);
    await this.assertRoomFor(project, input.name);
    const { environment } = this.deps;
    if (!environment) throw secretKeyNeeded();
    let provisioned;
    try {
      provisioned = await provisionPostgres({ prisma: this.deps.prisma, environment }, project, { name: input.name, version: input.version });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `This project already has a service named "${input.name}".`);
      throw error;
    }
    let { service } = provisioned;
    if (input.cpuLimit !== undefined || input.memoryLimitMb !== undefined) {
      service = await this.deps.prisma.service.update({
        where: { id: service.id },
        data: { cpuLimit: input.cpuLimit, memoryLimitMb: input.memoryLimitMb },
      });
    }
    this.deps.logger.info({ projectId, serviceId: service.id, name: service.name, image: service.image }, "Database created");
    await this.deps.audit.record({
      action: "SERVICE_CREATED",
      actorId: userId,
      project,
      metadata: { service: service.name, type: service.type, image: service.image, variable: provisioned.variable },
    });
    return { ...service, connectionVariable: provisioned.variable };
  }

  async update(serviceId: string, userId: string, input: UpdateServiceInput): Promise<Service> {
    const { service, project } = await this.find(serviceId, userId, OrgRole.ADMIN);
    if (service.type === "POSTGRES" && !updateDatabaseSchema.safeParse(input).success) {
      throw new ValidationError("A database only takes CPU and memory limits. Its version can't change: the data directory belongs to it.");
    }
    if (service.type === "WORKER" && input.public === true) throw new ValidationError("Workers can't be public.");
    // Remembered, so shipyard.yaml never overwrites what someone set here.
    const overrides = [...new Set([...service.overrides, ...Object.keys(input)])].sort();
    const updated = await this.deps.prisma.service.update({ where: { id: serviceId }, data: { ...input, overrides } });
    await this.deps.audit.record({
      action: "SERVICE_CHANGED",
      actorId: userId,
      project,
      metadata: { service: service.name, settings: Object.keys(input).sort().join(",") },
    });
    return updated;
  }

  /** Project-wide variables holding a URL that points at this database (as Shipyard wrote it). */
  private async urlVariablesOf(projectId: string, name: string): Promise<string[]> {
    if (!this.deps.environment) return [];
    // A variable that can't be decrypted can't be checked; it just isn't removed.
    const { runtime } = await this.deps.environment.forDeployment(projectId).catch(() => ({ runtime: {} as Record<string, string> }));
    return Object.entries(runtime)
      .filter(([, value]) => value.startsWith(`postgres://${POSTGRES_USER}:`) && value.includes(`@${name}:${POSTGRES_PORT}/`))
      .map(([key]) => key);
  }

  /** Room for one more service, and its address (<name>-<slug>) isn't another project's own. */
  private async assertRoomFor(project: { id: string; slug: string }, name: string): Promise<void> {
    const { prisma } = this.deps;
    if ((await prisma.service.count({ where: { projectId: project.id } })) >= MAX_SERVICES_PER_PROJECT) {
      throw new ValidationError(`A project can have at most ${MAX_SERVICES_PER_PROJECT} services.`);
    }
    if (await prisma.project.findUnique({ where: { slug: `${name}-${project.slug}` }, select: { id: true } })) {
      throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `"${name}" would clash with the address of another project. Choose another name.`);
    }
  }

  /** Removes the service with its containers, images, logs and its own variables. A project keeps at least one service. */
  async delete(serviceId: string, userId: string, options: { deleteData?: boolean } = {}): Promise<void> {
    const { service, project } = await this.find(serviceId, userId, OrgRole.ADMIN);
    const volumes = await this.deps.prisma.volume.findMany({ where: { serviceId } });
    if (volumes.length > 0 && !options.deleteData) throw volumesExist(volumes.map((v) => v.name));
    if ((await this.deps.prisma.service.count({ where: { projectId: project.id } })) <= 1) {
      throw new ConflictError(ErrorCode.INVALID_STATUS_TRANSITION, "A project needs at least one service. Delete the project instead.");
    }
    // A database's URL variable points at it: it goes too, or apps would keep a dead address.
    const urlKeys = service.type === "POSTGRES" ? await this.urlVariablesOf(project.id, service.name) : [];
    await this.deps.deployments.destroyServiceDeployments(project.id, serviceId, async () => {
      // The containers using them are gone now, so the volumes can go too.
      await this.deps.deployments.removeVolumes(volumes.map((volume) => volume.dockerName));
      await this.deps.prisma.$transaction([
        this.deps.prisma.volume.deleteMany({ where: { serviceId } }),
        this.deps.prisma.environmentVariable.deleteMany({ where: { projectId: project.id, scope: "project", key: { in: urlKeys } } }),
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
