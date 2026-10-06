import { type Environment, OrgRole, type OrganizationPolicy, type PrismaClient, type Project, type Service } from "../../db/prisma.js";
import { AppError, ErrorCode } from "../../lib/errors.js";
import { type AccessService, atLeast } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";
import { effectiveHealthCheck, effectiveResources } from "../services/serviceRules.js";

export type PolicyInput = Partial<Omit<OrganizationPolicy, "organizationId" | "updatedAt">>;

const NONE: Omit<OrganizationPolicy, "organizationId" | "updatedAt"> = {
  maxMemoryMb: null,
  maxCpu: null,
  maxReplicas: null,
  requireHealthCheckPath: false,
  allowedDomainSuffixes: [],
  requireApproval: false,
};

/**
 * Rules an organization sets for its projects. Checked before every
 * deployment is queued (a violation refuses it, listing every reason) and
 * when a custom domain is added; production deploys can require an ADMIN's
 * approval. Reading needs VIEWER, changing ADMIN.
 */
export class PolicyService {
  constructor(private readonly deps: { prisma: PrismaClient; access: AccessService; audit: Pick<AuditService, "record"> }) {}

  async get(organizationId: string, userId: string) {
    await this.deps.access.organization(organizationId, userId, OrgRole.VIEWER);
    return { organizationId, ...NONE, ...(await this.policyOf(organizationId)) };
  }

  async update(organizationId: string, userId: string, input: PolicyInput) {
    await this.deps.access.organization(organizationId, userId, OrgRole.ADMIN);
    const suffixes = input.allowedDomainSuffixes?.map((suffix) => suffix.trim().toLowerCase().replace(/^\.?/, "."));
    const data = { ...input, ...(suffixes && { allowedDomainSuffixes: suffixes }) };
    const policy = await this.deps.prisma.organizationPolicy.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
    await this.deps.audit.record({ action: "POLICY_CHANGED", actorId: userId, organizationId, metadata: { settings: Object.keys(input).sort().join(",") } });
    return policy;
  }

  /** Every way deploying these services would break the organization's policy (empty = allowed). */
  async violations(project: Project, services: readonly Service[], environment: Pick<Environment, "id"> | null): Promise<string[]> {
    const policy = await this.policyOf(project.organizationId);
    if (!policy) return [];
    const problems: string[] = [];
    for (const service of services) {
      const resources = effectiveResources(project, service);
      if (policy.maxMemoryMb !== null && (resources.memoryLimitMb === null || resources.memoryLimitMb > policy.maxMemoryMb)) {
        problems.push(`${service.name}: memory limit must be set, at most ${policy.maxMemoryMb} MB (it is ${resources.memoryLimitMb ?? "unlimited"})`);
      }
      if (policy.maxCpu !== null && (resources.cpuLimit === null || resources.cpuLimit > policy.maxCpu)) {
        problems.push(`${service.name}: CPU limit must be set, at most ${policy.maxCpu} (it is ${resources.cpuLimit ?? "unlimited"})`);
      }
      // Other environments run one replica.
      if (policy.maxReplicas !== null && !environment && service.replicas > policy.maxReplicas) {
        problems.push(`${service.name}: at most ${policy.maxReplicas} replicas (it asks for ${service.replicas})`);
      }
      if (policy.requireHealthCheckPath && service.type === "WEB" && effectiveHealthCheck(project, service).path === "/") {
        problems.push(`${service.name}: needs a health check path (not "/"), e.g. /healthz`);
      }
    }
    return problems;
  }

  async assertCanDeploy(project: Project, services: readonly Service[], environment: Pick<Environment, "id"> | null): Promise<void> {
    const problems = await this.violations(project, services, environment);
    if (problems.length > 0) {
      throw new AppError(ErrorCode.POLICY_VIOLATION, `Your organization's policy doesn't allow this deploy: ${problems.join("; ")}.`, { statusCode: 422 });
    }
  }

  /** Production deploys need an ADMIN's approval when the policy says so, unless an ADMIN (or OWNER) asked. */
  async needsApproval(project: Project, actorRole: OrgRole | null, environment: Pick<Environment, "id"> | null): Promise<boolean> {
    if (environment) return false;
    const policy = await this.policyOf(project.organizationId);
    return Boolean(policy?.requireApproval) && (actorRole === null || !atLeast(actorRole, OrgRole.ADMIN));
  }

  async assertDomainAllowed(organizationId: string, hostname: string): Promise<void> {
    const suffixes = (await this.policyOf(organizationId))?.allowedDomainSuffixes ?? [];
    if (suffixes.length > 0 && !suffixes.some((suffix) => `.${hostname}`.endsWith(suffix))) {
      throw new AppError(ErrorCode.POLICY_VIOLATION, `Your organization only allows domains under ${suffixes.join(", ")}.`, { statusCode: 422 });
    }
  }

  private policyOf(organizationId: string) {
    return this.deps.prisma.organizationPolicy.findUnique({ where: { organizationId } });
  }
}
