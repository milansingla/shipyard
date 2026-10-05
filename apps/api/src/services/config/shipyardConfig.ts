import { parse, YAMLParseError } from "yaml";
import { z } from "zod";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { healthCheckPathSchema } from "../../modules/projects/project.schemas.js";
import { mountPathSchema, serviceNameSchema, sourceDirSchema, volumeNameSchema } from "../../modules/services/service.schemas.js";
import { MAX_VOLUMES_PER_SERVICE } from "../../modules/services/VolumeService.js";
import { MAX_REPLICAS } from "../docker/naming.js";
import {
  MAX_CRON_JOBS_PER_PROJECT,
  cronCommandSchema,
  cronJobNameSchema,
  cronScheduleSchema,
  cronTimeoutSchema,
} from "../../modules/cron/cron.schemas.js";
import { DEFAULT_POSTGRES_VERSION, POSTGRES_VERSIONS, type PostgresVersion } from "../../modules/services/postgres.js";

/** File names Shipyard looks for at the repository root, in order. */
export const CONFIG_FILE_NAMES = ["shipyard.yaml", "shipyard.yml"] as const;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_CONFIG_SERVICES = 20;

const command = z.strictObject({ command: z.string().trim().min(1).max(1000).regex(/^[^\n\r\0]+$/, "must be a single line") });

const serviceSchema = z.strictObject({
  type: z.enum(["web", "worker", "postgres"]).default("web"),
  /** postgres only: the major version. */
  version: z.union(POSTGRES_VERSIONS.map((v) => z.literal(v))).optional(),
  source: sourceDirSchema.default("."),
  build: command.optional(),
  start: command.optional(),
  port: z.int().min(1).max(65535).optional(),
  public: z.boolean().optional(),
  replicas: z.int().min(1).max(MAX_REPLICAS).optional(),
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

const cronSchema = z.strictObject({
  /** The service whose image and variables it runs with. Default: "web", else the first service. */
  service: serviceNameSchema.optional(),
  schedule: cronScheduleSchema,
  command: cronCommandSchema,
  timeoutSeconds: cronTimeoutSchema.optional(),
});

const configSchema = z.strictObject({
  version: z.literal(1),
  services: z
    .record(serviceNameSchema, serviceSchema)
    .refine((services) => Object.keys(services).length > 0, "declare at least one service")
    .refine((services) => Object.keys(services).length <= MAX_CONFIG_SERVICES, `at most ${MAX_CONFIG_SERVICES} services`),
  cron: z
    .record(cronJobNameSchema, cronSchema)
    .refine((jobs) => Object.keys(jobs).length <= MAX_CRON_JOBS_PER_PROJECT, `at most ${MAX_CRON_JOBS_PER_PROJECT} cron jobs`)
    .optional(),
});

/** A cron job as shipyard.yaml declares it. */
export interface ConfiguredCronJob {
  name: string;
  service: string;
  schedule: string;
  command: string;
  timeoutSeconds?: number;
}

export interface ShipyardFile {
  services: ConfiguredService[];
  cron: ConfiguredCronJob[];
}

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
    replicas?: number;
    healthCheckPath?: string;
    healthCheckPort?: number;
    healthCheckTimeoutSeconds?: number;
    cpuLimit?: number;
    memoryLimitMb?: number;
  };
  volumes: { name: string; mountPath: string }[];
  /** Set for `type: postgres`: a database Shipyard runs, not a build of the repository. */
  database?: { version: PostgresVersion };
}

/**
 * Parses and validates shipyard.yaml. Errors name the file, the path in it,
 * and what is wrong, so they can be fixed from the build log alone.
 * Aliases are capped: a small file can't expand into a huge document.
 */
export function parseShipyardConfig(source: string, fileName = "shipyard.yaml"): ConfiguredService[] {
  return parseShipyardFile(source, fileName).services;
}

/** The whole file: services and cron jobs. */
export function parseShipyardFile(source: string, fileName = "shipyard.yaml"): ShipyardFile {
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

  const services = parseServices(result.data.services, fileName);
  const names = services.map((service) => service.name);
  const fallback = names.includes("web") ? "web" : names[0]!;
  const cron = Object.entries(result.data.cron ?? {}).map(([name, job]) => {
    const service = job.service ?? fallback;
    const target = services.find((candidate) => candidate.name === service);
    if (!target) throw invalid(fileName, `is invalid at cron.${name}.service: "${service}" isn't a service in this file`);
    if (target.database) throw invalid(fileName, `is invalid at cron.${name}.service: cron jobs run in a web service's or worker's image, not a database's`);
    return { name, service, schedule: job.schedule, command: job.command, ...(job.timeoutSeconds !== undefined && { timeoutSeconds: job.timeoutSeconds }) };
  });
  return { services, cron };
}

function parseServices(declared: z.infer<typeof configSchema>["services"], fileName: string): ConfiguredService[] {
  return Object.entries(declared).map(([name, service]) => {
    if (service.type === "postgres") {
      const extra =
        (["build", "start", "port", "public", "replicas", "healthCheck", "volumes"] as const).find((key) => service[key] !== undefined) ??
        (service.source !== "." ? "source" : undefined);
      if (extra) throw invalid(fileName, `is invalid at services.${name}.${extra}: a postgres service only takes version and resources`);
      return {
        name,
        settings: {
          type: "WEB" as const, // unused for databases; see `database`
          sourceDir: ".",
          ...(service.resources?.cpu !== undefined && { cpuLimit: service.resources.cpu }),
          ...(service.resources?.memoryMb !== undefined && { memoryLimitMb: service.resources.memoryMb }),
        },
        volumes: [],
        database: { version: service.version ?? DEFAULT_POSTGRES_VERSION },
      };
    }
    if (service.version !== undefined) throw invalid(fileName, `is invalid at services.${name}.version: only postgres services have a version`);
    if (service.type === "worker" && service.public) throw invalid(fileName, `is invalid at services.${name}.public: workers can't be public`);
    const settings: ConfiguredService["settings"] = {
      type: service.type === "worker" ? "WORKER" : "WEB",
      sourceDir: service.source,
      ...(service.build && { buildCommand: service.build.command }),
      ...(service.start && { startCommand: service.start.command }),
      ...(service.port !== undefined && { port: service.port }),
      ...(service.public !== undefined && { public: service.public }),
      ...(service.replicas !== undefined && { replicas: service.replicas }),
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
