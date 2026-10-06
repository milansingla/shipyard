import { type Deployment, type Environment, OrgRole, type PrismaClient, isUniqueViolation } from "../../db/prisma.js";
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { validateBranchName } from "../../services/git/branchName.js";
import type { AccessService } from "../access/AccessService.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import { DEVELOPMENT_NAME } from "./environmentRules.js";

export interface ProjectEnvironmentsDeps {
  prisma: PrismaClient;
  access: AccessService;
  deployments: Pick<DeploymentService, "deploy" | "closeEnvironment">;
  logger: Logger;
}

export interface EnvironmentView extends Environment {
  /** The newest deployment of each of its services. */
  deployments: Deployment[];
}

/**
 * A project's environments besides production: one development environment
 * tracking another branch, and pull-request previews (see PreviewService).
 * Reading needs VIEWER, deploying DEVELOPER, creating/changing/closing ADMIN.
 */
export class ProjectEnvironments {
  constructor(private readonly deps: ProjectEnvironmentsDeps) {}

  async list(projectId: string, userId: string): Promise<EnvironmentView[]> {
    await this.deps.access.project(projectId, userId, OrgRole.VIEWER);
    const environments = await this.deps.prisma.environment.findMany({
      where: { projectId },
      orderBy: [{ status: "asc" }, { type: "asc" }, { createdAt: "desc" }],
      include: { deployments: { distinct: ["serviceId"], orderBy: { createdAt: "desc" } } },
    });
    return environments;
  }

  /** Creates (or reopens) the development environment, tracking `branch`. Deploy it to start it. */
  async createDevelopment(projectId: string, userId: string, input: { branch: string }): Promise<Environment> {
    const project = await this.deps.access.project(projectId, userId, OrgRole.ADMIN);
    const branch = validateBranchName(input.branch);
    if (branch === project.branch) throw new ValidationError(`Production already deploys ${branch}. Pick another branch.`);
    if (await this.deps.prisma.project.findUnique({ where: { slug: `${DEVELOPMENT_NAME}-${project.slug}` }, select: { id: true } })) {
      throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `Another project already has the address ${DEVELOPMENT_NAME}-${project.slug}.`);
    }
    const existing = await this.deps.prisma.environment.findUnique({ where: { projectId_name: { projectId, name: DEVELOPMENT_NAME } } });
    if (existing?.status === "ACTIVE") throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, "This project already has a development environment.");
    try {
      return existing
        ? await this.deps.prisma.environment.update({ where: { id: existing.id }, data: { branch, status: "ACTIVE", closedAt: null } })
        : await this.deps.prisma.environment.create({ data: { projectId, type: "DEVELOPMENT", name: DEVELOPMENT_NAME, branch } });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, "This project already has a development environment.");
      throw error;
    }
  }

  /** Changes the branch a development environment tracks (from its next deploy). */
  async update(environmentId: string, userId: string, input: { branch: string }): Promise<Environment> {
    const { environment, project } = await this.find(environmentId, userId, OrgRole.ADMIN);
    if (environment.type !== "DEVELOPMENT") throw new ValidationError("A preview follows its pull request's branch.");
    const branch = validateBranchName(input.branch);
    if (branch === project.branch) throw new ValidationError(`Production already deploys ${branch}. Pick another branch.`);
    return this.deps.prisma.environment.update({ where: { id: environmentId }, data: { branch } });
  }

  async deploy(environmentId: string, userId: string): Promise<Deployment> {
    const { environment } = await this.find(environmentId, userId, OrgRole.VIEWER);
    return this.deps.deployments.deploy(environment.projectId, userId, undefined, { environmentId });
  }

  /** Removes its containers and images and marks it CLOSED; its deployments stay as history. Idempotent. */
  async close(environmentId: string, userId: string): Promise<Environment> {
    const { environment } = await this.find(environmentId, userId, OrgRole.ADMIN);
    return this.closeEnvironment(environment);
  }

  /** Also used by Shipyard itself (a pull request closed). */
  async closeEnvironment(environment: Environment): Promise<Environment> {
    if (environment.status === "CLOSED") return environment;
    let closed = environment;
    await this.deps.deployments.closeEnvironment(environment.projectId, environment.id, async () => {
      closed = await this.deps.prisma.environment.update({ where: { id: environment.id }, data: { status: "CLOSED", closedAt: new Date() } });
    });
    this.deps.logger.info({ projectId: environment.projectId, environment: environment.name }, "Environment closed");
    return closed;
  }

  private async find(environmentId: string, userId: string, need: OrgRole) {
    const environment = await this.deps.prisma.environment.findUnique({ where: { id: environmentId } });
    if (!environment) throw new NotFoundError(`Environment not found: ${environmentId}`);
    try {
      return { environment, project: await this.deps.access.project(environment.projectId, userId, need) };
    } catch (error) {
      throw error instanceof NotFoundError ? new NotFoundError(`Environment not found: ${environmentId}`) : error;
    }
  }
}
