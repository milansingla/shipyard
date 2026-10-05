import type { PrismaClient, Project, Service } from "../../db/prisma.js";
import { AppError, ErrorCode } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { CONFIG_FILE_NAMES, type ConfiguredService, MAX_CONFIG_BYTES, parseShipyardConfig } from "../../services/config/shipyardConfig.js";
import type { GitService } from "../../services/git/GitService.js";
import { parseRepositoryUrl } from "../../services/git/repositoryUrl.js";

type FileSetting =
  | "type"
  | "sourceDir"
  | "buildCommand"
  | "startCommand"
  | "port"
  | "public"
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
  healthCheckPath: null,
  healthCheckPort: null,
  healthCheckTimeoutSeconds: null,
  cpuLimit: null,
  memoryLimitMb: null,
};

export interface ConfigSyncDeps {
  prisma: PrismaClient;
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
    const configured = parseShipyardConfig(file.content, file.name);

    const { prisma } = this.deps;
    const existing = await prisma.service.findMany({ where: { projectId: project.id } });
    const notes = [`Using ${file.name} from commit ${file.commitSha.slice(0, 7)}`];

    for (const service of configured) {
      const current = existing.find((candidate) => candidate.name === service.name);
      const wanted = fileValues(service);
      if (!current) {
        await this.assertAddressFree(project, service.name, file.name);
        await prisma.service.create({ data: { projectId: project.id, name: service.name, ...wanted, managedBy: "CONFIG_FILE" } });
        notes.push(`added service ${service.name}`);
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
    }

    for (const stale of existing.filter((s) => s.managedBy === "CONFIG_FILE" && !configured.some((c) => c.name === s.name))) {
      notes.push(`service ${stale.name} is no longer in ${file.name}; it keeps its last settings. Delete it on the project page if it's gone for good`);
    }
    this.deps.logger.info({ projectId: project.id, file: file.name, notes }, "Synced services from configuration file");
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
