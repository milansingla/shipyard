import { type Deployment, type PrismaClient, type Project, isUniqueViolation } from "../../db/prisma.js";
import { ConflictError, ErrorCode, NotFoundError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { toDockerSlug } from "../../services/docker/naming.js";
import { validateBranchName } from "../../services/git/branchName.js";
import type { GitService } from "../../services/git/GitService.js";
import { parseRepositoryUrl } from "../../services/git/repositoryUrl.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import type { CreateProjectInput } from "./project.schemas.js";

export interface ProjectWithLatestDeployment extends Project {
  latestDeployment: Deployment | null;
}

export interface ProjectServiceDeps {
  prisma: PrismaClient;
  git: Pick<GitService, "resolveBranch">;
  deployments: Pick<DeploymentService, "destroyProjectDeployments">;
  allowedGitHosts: readonly string[];
  logger: Logger;
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  /**
   * Validates the repository URL and branch, then checks against the real
   * remote that the repository is reachable and the branch exists — so a typo
   * fails now with a clear 422 instead of later as a FAILED deployment.
   */
  async create(input: CreateProjectInput): Promise<Project> {
    const repository = parseRepositoryUrl(input.repositoryUrl, this.deps.allowedGitHosts);
    const requestedBranch = input.branch === undefined ? null : validateBranchName(input.branch);
    const branch = await this.deps.git.resolveBranch(repository, requestedBranch);

    const name = input.name ?? repository.name;
    const slug = toDockerSlug(name);

    try {
      const project = await this.deps.prisma.project.create({
        data: {
          name,
          slug,
          repositoryUrl: repository.cloneUrl,
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          branch,
        },
      });
      this.deps.logger.info({ projectId: project.id, slug, branch }, "Project created");
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

  /** All projects, newest first, each with its most recent deployment (for the dashboard). */
  async list(): Promise<ProjectWithLatestDeployment[]> {
    const projects = await this.deps.prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      include: { deployments: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    return projects.map(({ deployments, ...project }) => ({ ...project, latestDeployment: deployments[0] ?? null }));
  }

  async get(id: string): Promise<ProjectWithLatestDeployment> {
    const project = await this.deps.prisma.project.findUnique({
      where: { id },
      include: { deployments: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!project) throw new NotFoundError(`Project not found: ${id}`);
    const { deployments, ...rest } = project;
    return { ...rest, latestDeployment: deployments[0] ?? null };
  }

  /** Removes the project, all its containers/images/logs, and its deployment history. */
  async delete(id: string): Promise<void> {
    await this.get(id); // 404 before touching anything
    await this.deps.deployments.destroyProjectDeployments(id, async () => {
      await this.deps.prisma.project.delete({ where: { id } }); // cascades to deployments
    });
    this.deps.logger.info({ projectId: id }, "Project deleted");
  }
}
