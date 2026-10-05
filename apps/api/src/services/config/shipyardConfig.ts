import { parse, YAMLParseError } from "yaml";
import { z } from "zod";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { healthCheckPathSchema } from "../../modules/projects/project.schemas.js";
import { mountPathSchema, serviceNameSchema, sourceDirSchema, volumeNameSchema } from "../../modules/services/service.schemas.js";
import { MAX_VOLUMES_PER_SERVICE } from "../../modules/services/VolumeService.js";

/** File names Shipyard looks for at the repository root, in order. */
export const CONFIG_FILE_NAMES = ["shipyard.yaml", "shipyard.yml"] as const;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_CONFIG_SERVICES = 20;

const command = z.strictObject({ command: z.string().trim().min(1).max(1000).regex(/^[^\n\r\0]+$/, "must be a single line") });

const serviceSchema = z.strictObject({
  type: z.enum(["web", "worker"]).default("web"),
  source: sourceDirSchema.default("."),
  build: command.optional(),
  start: command.optional(),
  port: z.int().min(1).max(65535).optional(),
  public: z.boolean().optional(),
  healthCheck: z
    .strictObject({
      path: healthCheckPathSchema.optional(),
      port: z.int().min(1).max(65535).optional(),
      timeoutSeconds: z.int().min(5).max(900).optional(),
    })
    .optional(),
  resources: z
    .strictObject({
      cpu: z.number().min(0.1).max(64).multipleOf(0.01).optional(),
      memoryMb: z.int().min(64).max(262_144).optional(),
    })
    .optional(),
  /** name → mount path. Only ever added from the file: removing one is a dashboard action. */
  volumes: z
    .record(volumeNameSchema, mountPathSchema)
    .refine((volumes) => Object.keys(volumes).length <= MAX_VOLUMES_PER_SERVICE, `at most ${MAX_VOLUMES_PER_SERVICE} volumes`)
    .optional(),
});

const configSchema = z.strictObject({
  version: z.literal(1),
  services: z
    .record(serviceNameSchema, serviceSchema)
    .refine((services) => Object.keys(services).length > 0, "declare at least one service")
    .refine((services) => Object.keys(services).length <= MAX_CONFIG_SERVICES, `at most ${MAX_CONFIG_SERVICES} services`),
});

/** One service as shipyard.yaml declares it, in the Service model's terms. Absent = not set by the file. */
export interface ConfiguredService {
  name: string;
  settings: {
    type: "WEB" | "WORKER";
    sourceDir: string;
    buildCommand?: string;
    startCommand?: string;
    port?: number;
    public?: boolean;
    healthCheckPath?: string;
    healthCheckPort?: number;
    healthCheckTimeoutSeconds?: number;
    cpuLimit?: number;
    memoryLimitMb?: number;
  };
  volumes: { name: string; mountPath: string }[];
}

/**
 * Parses and validates shipyard.yaml. Errors name the file, the path in it,
 * and what is wrong, so they can be fixed from the build log alone.
 * Aliases are capped: a small file can't expand into a huge document.
 */
export function parseShipyardConfig(source: string, fileName = "shipyard.yaml"): ConfiguredService[] {
  let document: unknown;
  try {
    document = parse(source, { maxAliasCount: 50, prettyErrors: false });
  } catch (error) {
    const where = error instanceof YAMLParseError && error.linePos ? ` (line ${error.linePos[0].line})` : "";
    throw invalid(fileName, `is not valid YAML${where}: ${(error as Error).message.split("\n")[0]}`);
  }

  const result = configSchema.safeParse(document);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const at = issue.path.length ? ` at ${issue.path.join(".")}` : "";
    throw invalid(fileName, `is invalid${at}: ${issue.message}`);
  }

  return Object.entries(result.data.services).map(([name, service]) => {
    if (service.type === "worker" && service.public) throw invalid(fileName, `is invalid at services.${name}.public: workers can't be public`);
    const settings: ConfiguredService["settings"] = {
      type: service.type === "worker" ? "WORKER" : "WEB",
      sourceDir: service.source,
      ...(service.build && { buildCommand: service.build.command }),
      ...(service.start && { startCommand: service.start.command }),
      ...(service.port !== undefined && { port: service.port }),
      ...(service.public !== undefined && { public: service.public }),
      ...(service.healthCheck?.path !== undefined && { healthCheckPath: service.healthCheck.path }),
      ...(service.healthCheck?.port !== undefined && { healthCheckPort: service.healthCheck.port }),
      ...(service.healthCheck?.timeoutSeconds !== undefined && { healthCheckTimeoutSeconds: service.healthCheck.timeoutSeconds }),
      ...(service.resources?.cpu !== undefined && { cpuLimit: service.resources.cpu }),
      ...(service.resources?.memoryMb !== undefined && { memoryLimitMb: service.resources.memoryMb }),
    };
    const volumes = Object.entries(service.volumes ?? {}).map(([volume, mountPath]) => ({ name: volume, mountPath }));
    if (new Set(volumes.map((v) => v.mountPath)).size !== volumes.length) {
      throw invalid(fileName, `is invalid at services.${name}.volumes: two volumes can't share a mount path`);
    }
    return { name, settings, volumes };
  });
}

function invalid(fileName: string, problem: string): AppError {
  return new AppError(ErrorCode.CONFIG_INVALID, `${fileName} ${problem}`, { statusCode: 422 });
}
