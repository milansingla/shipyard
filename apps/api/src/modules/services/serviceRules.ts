import type { Project, Service } from "../../db/prisma.js";
import type { ContainerResources, HealthCheckSettings } from "../../services/docker/DockerService.js";
import type { ServiceSpec } from "../../services/deployment/types.js";
import { POSTGRES_DB, POSTGRES_PORT, POSTGRES_USER, postgresHealthCommand } from "./postgres.js";

/**
 * Pure rules for services, shared by the deploy pipeline, routing and the API.
 */

/** The project's private network: its services reach each other here by name. */
export function projectNetworkName(projectId: string): string {
  return `shipyard-p-${projectId.replace(/-/g, "").slice(0, 12)}`;
}

/**
 * The service that owns the project's own address (<slug>.<domain>): the
 * public web service named "web", else the oldest public web service.
 */
export function primaryServiceId(services: ReadonlyArray<Pick<Service, "id" | "name" | "type" | "public" | "createdAt">>): string | null {
  const routable = services
    .filter((service) => service.type === "WEB" && service.public)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return (routable.find((service) => service.name === "web") ?? routable[0])?.id ?? null;
}

/**
 * First hostname label of a public web service: the project's slug for the
 * primary one, `<service>-<slug>` for the others. Uniqueness across projects
 * is checked when projects and services are created (see ServiceService).
 */
export function routeName(project: Pick<Project, "slug">, service: Pick<Service, "id" | "name">, primaryId: string | null): string {
  return service.id === primaryId ? project.slug : `${service.name}-${project.slug}`;
}

/** Base for image and container names. */
export function artifactName(project: Pick<Project, "slug">, service: Pick<Service, "name">): string {
  return `${project.slug}-${service.name}`;
}

export function serviceSpec(project: Pick<Project, "id">, service: Service): ServiceSpec {
  if (service.type === "POSTGRES") {
    return {
      type: "POSTGRES",
      sourceDir: ".",
      buildCommand: null,
      startCommand: null,
      port: POSTGRES_PORT,
      public: false,
      network: projectNetworkName(project.id),
      alias: service.name,
      image: { name: service.image!, healthCommand: postgresHealthCommand() },
      environment: { POSTGRES_USER, POSTGRES_DB },
      stopFirst: true,
    };
  }
  return {
    type: service.type,
    sourceDir: service.sourceDir,
    buildCommand: service.buildCommand,
    startCommand: service.startCommand,
    port: service.port,
    public: service.type === "WEB" && service.public,
    network: projectNetworkName(project.id),
    alias: service.name,
  };
}

/** The service's own setting where it has one, the project's otherwise. */
export function effectiveHealthCheck(project: Project, service: Service): HealthCheckSettings {
  const timeoutSeconds = service.healthCheckTimeoutSeconds ?? project.healthCheckTimeoutSeconds;
  return {
    path: service.healthCheckPath ?? project.healthCheckPath,
    port: service.healthCheckPort ?? project.healthCheckPort,
    timeoutMs: timeoutSeconds === null ? null : timeoutSeconds * 1000,
  };
}

export function effectiveResources(project: Project, service: Service): ContainerResources {
  return {
    cpuLimit: service.cpuLimit ?? project.cpuLimit,
    memoryLimitMb: service.memoryLimitMb ?? project.memoryLimitMb,
    restartPolicy: project.restartPolicy,
  };
}
