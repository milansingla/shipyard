import { OrgRole, type PrismaClient, type Volume, isUniqueViolation } from "../../db/prisma.js";
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { AccessService } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";

export const MAX_VOLUMES_PER_SERVICE = 10;

export interface VolumeServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

/**
 * The Docker volume name. It carries the service's id, not just names: a
 * detached volume outlives its row, and slugs are reused after a project is
 * deleted (and "a-b"/"c" reads like "a"/"b-c"), so a name built from slugs
 * alone could hand one project's leftover data to another.
 */
export function dockerVolumeName(serviceId: string, volumeName: string): string {
  return `shipyard-${serviceId}-${volumeName}`;
}

/**
 * Persistent volumes of a service. Adding one mounts it from the next deploy
 * on. Removing one only DETACHES it: later deployments stop mounting it, but
 * the data stays on the server (adding a volume with the same name picks it
 * up again). Data is deleted only with its service or project, and only when
 * that request explicitly says deleteData=true.
 */
export class VolumeService {
  constructor(private readonly deps: VolumeServiceDeps) {}

  async list(serviceId: string, userId: string): Promise<Volume[]> {
    await this.service(serviceId, userId, OrgRole.VIEWER);
    return this.deps.prisma.volume.findMany({ where: { serviceId }, orderBy: { createdAt: "asc" } });
  }

  async create(serviceId: string, userId: string, input: { name: string; mountPath: string }): Promise<Volume> {
    const { service, project } = await this.service(serviceId, userId, OrgRole.ADMIN);
    const { prisma } = this.deps;
    if ((await prisma.volume.count({ where: { serviceId } })) >= MAX_VOLUMES_PER_SERVICE) {
      throw new ValidationError(`A service can have at most ${MAX_VOLUMES_PER_SERVICE} volumes.`);
    }
    try {
      const volume = await prisma.volume.create({
        data: { serviceId, ...input, dockerName: dockerVolumeName(service.id, input.name) },
      });
      await this.deps.audit.record({
        action: "VOLUME_CREATED",
        actorId: userId,
        project,
        metadata: { service: service.name, volume: volume.name, mountPath: volume.mountPath },
      });
      return volume;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, "This service already has a volume with that name or path.");
      }
      throw error;
    }
  }

  /** Detaches: future deployments stop mounting it; the data is kept. */
  async detach(volumeId: string, userId: string): Promise<{ dockerName: string }> {
    const volume = await this.deps.prisma.volume.findUnique({ where: { id: volumeId } });
    if (!volume) throw new NotFoundError(`Volume not found: ${volumeId}`);
    const { service, project } = await this.service(volume.serviceId, userId, OrgRole.ADMIN).catch((error: unknown) => {
      throw error instanceof NotFoundError ? new NotFoundError(`Volume not found: ${volumeId}`) : error;
    });
    await this.deps.prisma.volume.delete({ where: { id: volumeId } });
    await this.deps.audit.record({
      action: "VOLUME_DELETED",
      actorId: userId,
      project,
      metadata: { service: service.name, volume: volume.name, dataKept: true },
    });
    return { dockerName: volume.dockerName };
  }

  private async service(serviceId: string, userId: string, need: OrgRole) {
    const service = await this.deps.prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) throw new NotFoundError(`Service not found: ${serviceId}`);
    try {
      return { service, project: await this.deps.access.project(service.projectId, userId, need) };
    } catch (error) {
      throw error instanceof NotFoundError ? new NotFoundError(`Service not found: ${serviceId}`) : error;
    }
  }
}
