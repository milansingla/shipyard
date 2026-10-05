import type { PrismaClient, Project, Service } from "../../db/prisma.js";
import { AppError, ErrorCode } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { nextRun, parseCron } from "../../lib/cron.js";
import {
  CONFIG_FILE_NAMES,
  type ConfiguredCronJob,
  type ConfiguredService,
  MAX_CONFIG_BYTES,
  parseShipyardFile,
} from "../../services/config/shipyardConfig.js";
import type { GitService } from "../../services/git/GitService.js";
import { parseRepositoryUrl } from "../../services/git/repositoryUrl.js";
import type { EnvironmentService } from "../environment/EnvironmentService.js";
import { postgresVersionOf } from "./postgres.js";
import { provisionPostgres } from "./PostgresProvisioner.js";
import { MAX_VOLUMES_PER_SERVICE, dockerVolumeName } from "./VolumeService.js";

type FileSetting =
  | "type"
  | "sourceDir"
  | "buildCommand"
  | "startCommand"
  | "port"
  | "public"
  | "replicas"
  | "healthCheckPath"
  | "healthCheckPort"
  | "healthCheckTimeoutSeconds"
  | "cpuLimit"
  | "memoryLimitMb";

type FileSettings = Pick<Service, FileSetting>;

/** Settings shipyard.yaml can set, and their value when it doesn't. */
const FILE_DEFAULTS: FileSettings = {
  type: "WEB",
  sourceDir: ".",
  buildCommand: null,
  startCommand: null,
  port: null,
  public: true,
  replicas: 1,
  healthCheckPath: null,
  healthCheckPort: null,
  healthCheckTimeoutSeconds: null,
  cpuLimit: null,
  memoryLimitMb: null,
};

export interface ConfigSyncDeps {
  prisma: PrismaClient;
  /** Encrypts a new database's password; null without SHIPYARD_SECRET_KEY. */
  environment?: Pick<EnvironmentService, "sealedRows"> | null;
  git: Pick<GitService, "readFile">;
  allowedGitHosts: readonly string[];
  logger: Logger;
}

/**
 * Brings a project's services in line with the repository's shipyard.yaml,
 * read at the branch's latest commit. Precedence, lowest to highest:
 *
 *   platform defaults → detection → shipyard.yaml → dashboard settings
 *
 * so a setting changed in the dashboard (recorded in `overrides`) is never
 * overwritten by the file. Services the file no longer declares are kept as
 * they are and reported: removing a running service is never automatic.
 */
export class ConfigSync {
  constructor(private readonly deps: ConfigSyncDeps) {}

  /** Returns notes for the build log; throws CONFIG_INVALID when the file is wrong. */
  async sync(project: Project): Promise<string[]> {
    const repository = parseRepositoryUrl(project.repositoryUrl, this.deps.allowedGitHosts);
    const file = await this.deps.git.readFile(repository, project.branch, CONFIG_FILE_NAMES, MAX_CONFIG_BYTES);
    if (!file) return [];
    const { services: configured, cron } = parseShipyardFile(file.content, file.name);

    const { prisma } = this.deps;
    const existing = await prisma.service.findMany({ where: { projectId: project.id } });
    const notes = [`Using ${file.name} from commit ${file.commitSha.slice(0, 7)}`];

    for (const service of configured) {
      const current = existing.find((candidate) => candidate.name === service.name);
      if (service.database || current?.type === "POSTGRES") {
        notes.push(...(await this.syncDatabase(project, current, service, file.name)));
        continue;
      }
      const wanted = fileValues(service);
      if (!current) {
        await this.assertAddressFree(project, service.name, file.name);
        const created = await prisma.service.create({ data: { projectId: project.id, name: service.name, ...wanted, managedBy: "CONFIG_FILE" } });
        notes.push(`added service ${service.name}`);
        notes.push(...(await this.syncVolumes(created, service)));
        continue;
      }
      const changes: Partial<FileSettings> = {};
      const kept: string[] = [];
      for (const key of Object.keys(wanted) as FileSetting[]) {
        if (current[key] === wanted[key]) continue;
        if (current.overrides.includes(key)) kept.push(key);
        else Object.assign(changes, { [key]: wanted[key] });
      }
      if (Object.keys(changes).length > 0 || current.managedBy !== "CONFIG_FILE") {
        await prisma.service.update({ where: { id: current.id }, data: { ...changes, managedBy: "CONFIG_FILE" } });
      }
      if (Object.keys(changes).length > 0) notes.push(`updated ${service.name}: ${Object.keys(changes).join(", ")}`);
      if (kept.length > 0) notes.push(`kept the dashboard's ${kept.join(", ")} for ${service.name} (dashboard settings win)`);
      notes.push(...(await this.syncVolumes(current, service)));
    }

    for (const stale of existing.filter((s) => s.managedBy === "CONFIG_FILE" && !configured.some((c) => c.name === s.name))) {
      notes.push(`service ${stale.name} is no longer in ${file.name}; it keeps its last settings. Delete it on the project page if it's gone for good`);
    }
    notes.push(...(await this.syncCronJobs(project, cron, file.name)));
    this.deps.logger.info({ projectId: project.id, file: file.name, notes }, "Synced services from configuration file");
    return notes;
  }

  /**
   * Cron jobs: created or updated from the file (schedule, command, timeout,
   * service). Whether one is enabled stays a dashboard decision. Jobs the file
   * no longer declares are kept and reported, like services.
   */
  private async syncCronJobs(project: Project, configured: ConfiguredCronJob[], fileName: string): Promise<string[]> {
    const { prisma } = this.deps;
    const existing = await prisma.cronJob.findMany({ where: { projectId: project.id } });
    const services = await prisma.service.findMany({ where: { projectId: project.id }, select: { id: true, name: true } });
    const notes: string[] = [];
    for (const job of configured) {
      const serviceId = services.find((service) => service.name === job.service)!.id;
      const wanted = { serviceId, schedule: job.schedule, command: job.command, timeoutSeconds: job.timeoutSeconds ?? 3600 };
      const current = existing.find((candidate) => candidate.name === job.name);
      if (!current) {
        await prisma.cronJob.create({
          data: { projectId: project.id, name: job.name, ...wanted, managedBy: "CONFIG_FILE", nextRunAt: nextRun(parseCron(job.schedule), new Date()) },
        });
        notes.push(`added cron job ${job.name} (${job.schedule})`);
        continue;
      }
      const changed = (Object.keys(wanted) as Array<keyof typeof wanted>).filter((key) => current[key] !== wanted[key]);
      if (changed.length > 0 || current.managedBy !== "CONFIG_FILE") {
        await prisma.cronJob.update({
          where: { id: current.id },
          data: {
            ...wanted,
            managedBy: "CONFIG_FILE",
            ...(changed.includes("schedule") && current.enabled && { nextRunAt: nextRun(parseCron(job.schedule), new Date()) }),
          },
        });
      }
      if (changed.length > 0) notes.push(`updated cron job ${job.name}: ${changed.join(", ")}`);
    }
    for (const stale of existing.filter((job) => job.managedBy === "CONFIG_FILE" && !configured.some((c) => c.name === job.name))) {
      notes.push(`cron job ${stale.name} is no longer in ${fileName}; it keeps running. Delete it on the project page if it's gone for good`);
    }
    return notes;
  }

  /**
   * A `type: postgres` service: created with its volume, password and URL;
   * afterwards only its resources follow the file. The version never changes
   * (the data directory belongs to it), and a service never switches between
   * being a database and being built from the repository.
   */
  private async syncDatabase(project: Project, current: Service | undefined, service: ConfiguredService, fileName: string): Promise<string[]> {
    const { prisma } = this.deps;
    if (!service.database) {
      throw new AppError(ErrorCode.CONFIG_INVALID, `${fileName}: service "${service.name}" is a database here; it can't become a ${service.settings.type.toLowerCase()} service. Use another name.`, { statusCode: 422 });
    }
    if (current && current.type !== "POSTGRES") {
      throw new AppError(ErrorCode.CONFIG_INVALID, `${fileName}: service "${service.name}" is already a ${current.type.toLowerCase()} service; it can't become a database. Use another name.`, { statusCode: 422 });
    }
    const resources = {
      cpuLimit: service.settings.cpuLimit ?? null,
      memoryLimitMb: service.settings.memoryLimitMb ?? null,
    };
    if (!current) {
      if (!this.deps.environment) {
        throw new AppError(ErrorCode.CONFIG_INVALID, `${fileName}: databases need SHIPYARD_SECRET_KEY to be set on the Shipyard server.`, { statusCode: 422 });
      }
      await this.assertAddressFree(project, service.name, fileName);
      const { service: created, variable } = await provisionPostgres({ prisma, environment: this.deps.environment }, project, {
        name: service.name,
        version: service.database.version,
        managedBy: "CONFIG_FILE",
      });
      if (resources.cpuLimit !== null || resources.memoryLimitMb !== null) await prisma.service.update({ where: { id: created.id }, data: resources });
      return [`added database ${service.name} (PostgreSQL ${service.database.version}); its URL is in ${variable}`];
    }
    const notes: string[] = [];
    const version = postgresVersionOf(current.image);
    if (version !== service.database.version) {
      notes.push(`database ${service.name} stays on PostgreSQL ${version}: moving to ${service.database.version} needs a dump and restore (see docs/databases.md)`);
    }
    const changes = Object.fromEntries(
      (Object.keys(resources) as Array<keyof typeof resources>).filter((key) => current[key] !== resources[key] && !current.overrides.includes(key)).map((key) => [key, resources[key]]),
    );
    if (Object.keys(changes).length > 0 || current.managedBy !== "CONFIG_FILE") {
      await prisma.service.update({ where: { id: current.id }, data: { ...changes, managedBy: "CONFIG_FILE" } });
    }
    if (Object.keys(changes).length > 0) notes.push(`updated ${service.name}: ${Object.keys(changes).join(", ")}`);
    return notes;
  }

  /**
   * Adds the volumes the file declares and the service doesn't have yet.
   * Never removes or moves one: that would hide data, so it's a dashboard action.
   */
  private async syncVolumes(service: Service, configured: ConfiguredService): Promise<string[]> {
    if (configured.volumes.length === 0) return [];
    const { prisma } = this.deps;
    const existing = await prisma.volume.findMany({ where: { serviceId: service.id } });
    const notes: string[] = [];
    for (const volume of configured.volumes) {
      const current = existing.find((candidate) => candidate.name === volume.name);
      if (current) {
        if (current.mountPath !== volume.mountPath) {
          notes.push(`volume ${volume.name} of ${service.name} stays at ${current.mountPath}; moving it is done on the project page`);
        }
        continue;
      }
      const clash = existing.find((candidate) => candidate.mountPath === volume.mountPath);
      if (clash) {
        notes.push(`volume ${volume.name} of ${service.name} not added: ${volume.mountPath} is already volume ${clash.name}`);
        continue;
      }
      if (existing.length >= MAX_VOLUMES_PER_SERVICE) {
        notes.push(`volume ${volume.name} of ${service.name} not added: at most ${MAX_VOLUMES_PER_SERVICE} volumes`);
        continue;
      }
      existing.push(
        await prisma.volume.create({
          data: { serviceId: service.id, ...volume, dockerName: dockerVolumeName(service.id, volume.name) },
        }),
      );
      notes.push(`added volume ${volume.name} at ${volume.mountPath} to ${service.name}`);
    }
    return notes;
  }

  private async assertAddressFree(project: Project, name: string, fileName: string): Promise<void> {
    if (await this.deps.prisma.project.findUnique({ where: { slug: `${name}-${project.slug}` }, select: { id: true } })) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID,
        `${fileName}: service "${name}" would clash with the address of another project. Rename it.`,
        { statusCode: 422 },
      );
    }
  }
}

/** Every file-controlled setting: the file's value, or its default when the file leaves it out. */
function fileValues(service: ConfiguredService): FileSettings {
  const values: FileSettings = { ...FILE_DEFAULTS, ...service.settings };
  if (values.type === "WORKER") values.public = false;
  return values;
}
