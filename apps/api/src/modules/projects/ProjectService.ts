import { type Deployment, OrgRole, type PrismaClient, type Project, isUniqueViolation } from "../../db/prisma.js";
import { ConflictError, ErrorCode } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { toDockerSlug } from "../../services/docker/naming.js";
import { validateBranchName } from "../../services/git/branchName.js";
import type { GitService } from "../../services/git/GitService.js";
import { parseRepositoryUrl } from "../../services/git/repositoryUrl.js";
import type { AccessService, ProjectWithRole } from "../access/AccessService.js";
import type { AuditService } from "../audit/AuditService.js";
import { volumesExist } from "../services/ServiceService.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import type { CreateProjectInput, UpdateProjectInput } from "./project.schemas.js";

export interface ProjectWithLatestDeployment extends ProjectWithRole {
  latestDeployment: Deployment | null;
}

export interface ProjectServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  git: Pick<GitService, "resolveBranch">;
  deployments: Pick<DeploymentService, "destroyProjectDeployments" | "removeVolumes">;
  allowedGitHosts: readonly string[];
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

/**
 * Projects belong to organizations; every method takes the acting user's id
 * and checks their role there (see AccessService). Projects of organizations
 * the user isn't in are reported as "not found" (404), so their ids can't be
 * probed. Responses carry the user's `role`, so clients can hide what it
 * doesn't allow (the API enforces it regardless).
 */
export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  /**
   * Validates the repository URL and branch, then checks against the real
   * remote that the repository is reachable and the branch exists — so a typo
   * fails now with a clear 422 instead of later as a FAILED deployment.
   */
  async create(input: CreateProjectInput, userId: string): Promise<Project> {
    const organization = input.organizationId
      ? await this.deps.access.organization(input.organizationId, userId, OrgRole.DEVELOPER)
      : await this.deps.access.personalOrganization(userId);
    const repository = parseRepositoryUrl(input.repositoryUrl, this.deps.allowedGitHosts);
    const requestedBranch = input.branch === undefined ? null : validateBranchName(input.branch);
    const branch = await this.deps.git.resolveBranch(repository, requestedBranch);

    const name = input.name ?? repository.name;
    const slug = toDockerSlug(name);
    await this.assertAddressFree(slug);

    try {
      const project = await this.deps.prisma.project.create({
        data: {
          organizationId: organization.id,
          createdById: userId,
          name,
          slug,
          repositoryUrl: repository.cloneUrl,
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          branch,
          // Every project starts with one public web service at the repository root.
          services: { create: { name: "web" } },
        },
      });
      this.deps.logger.info({ projectId: project.id, organizationId: organization.id, slug, branch }, "Project created");
      await this.deps.audit.record({
        action: "PROJECT_CREATED",
        actorId: userId,
        project,
        metadata: { repository: `${repository.owner}/${repository.name}`, branch },
      });
      return project;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          ErrorCode.PROJECT_ALREADY_EXISTS,
          `A project named "${slug}" already exists. Choose a different name.`,
        );
      }
      throw error;
    }
  }

  /** All projects of the user's organizations, newest first, each with its most recent deployment. */
  async list(userId: string): Promise<ProjectWithLatestDeployment[]> {
    const projects = await this.deps.prisma.project.findMany({
      where: this.deps.access.visibleProjects(userId),
      orderBy: { createdAt: "desc" },
      include: {
        deployments: { orderBy: { createdAt: "desc" }, take: 1 },
        organization: { select: { id: true, name: true, personal: true, memberships: { where: { userId }, select: { role: true } } } },
      },
    });
    return projects.map(({ deployments, organization: { memberships, ...organization }, ...project }) => ({
      ...project,
      organization,
      role: memberships[0]!.role,
      latestDeployment: deployments[0] ?? null,
    }));
  }

  async get(id: string, userId: string): Promise<ProjectWithLatestDeployment> {
    const project = await this.deps.access.project(id, userId);
    return { ...project, latestDeployment: await this.latestDeployment(id) };
  }

  /** Updates settings; they apply to the next deployment. Needs ADMIN. */
  async update(id: string, userId: string, input: UpdateProjectInput): Promise<ProjectWithLatestDeployment> {
    await this.deps.access.project(id, userId, OrgRole.ADMIN);
    const project = await this.deps.prisma.project.update({ where: { id }, data: input });
    this.deps.logger.info({ projectId: id, settings: Object.keys(input) }, "Project settings updated");
    await this.deps.audit.record({
      action: "PROJECT_SETTINGS_CHANGED",
      actorId: userId,
      project,
      metadata: { settings: Object.keys(input).sort().join(",") },
    });
    return this.get(id, userId);
  }

  /** Removes the project, all its containers/images/logs, and its deployment history. Needs ADMIN. */
  async delete(id: string, userId: string, options: { deleteData?: boolean } = {}): Promise<void> {
    const project = await this.deps.access.project(id, userId, OrgRole.ADMIN);
    const volumes = await this.deps.prisma.volume.findMany({ where: { service: { projectId: id } } });
    if (volumes.length > 0 && !options.deleteData) throw volumesExist(volumes.map((v) => v.name));
    await this.deps.deployments.destroyProjectDeployments(id, async () => {
      await this.deps.deployments.removeVolumes(volumes.map((volume) => volume.dockerName));
      await this.deps.prisma.$transaction([
        this.deps.prisma.volume.deleteMany({ where: { service: { projectId: id } } }),
        this.deps.prisma.project.delete({ where: { id } }), // cascades to services and deployments
      ]);
    });
    this.deps.logger.info({ projectId: id }, "Project deleted");
    await this.deps.audit.record({ action: "PROJECT_DELETED", actorId: userId, project });
  }

  /**
   * A non-primary public service is served at <service>-<slug>. A new project's
   * slug must not equal such an address of an existing project.
   */
  private async assertAddressFree(slug: string): Promise<void> {
    const splits = [...slug.matchAll(/-/g)].map((match) => match.index!);
    for (const at of splits) {
      const clash = await this.deps.prisma.service.findFirst({
        where: { name: slug.slice(0, at), project: { slug: slug.slice(at + 1) } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `"${slug}" is already the address of another project's service. Choose a different name.`);
      }
    }
  }

  private async latestDeployment(projectId: string): Promise<Deployment | null> {
    return this.deps.prisma.deployment.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" } });
  }
}
