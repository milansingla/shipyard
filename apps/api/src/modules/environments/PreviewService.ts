import type { PrismaClient } from "../../db/prisma.js";
import { errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { validateBranchName } from "../../services/git/branchName.js";
import type { DeploymentService } from "../deployments/DeploymentService.js";
import type { PullRequestTarget } from "../webhooks/pullRequestEvent.js";
import { previewName } from "./environmentRules.js";
import type { ProjectEnvironments } from "./ProjectEnvironments.js";

export interface PreviewServiceDeps {
  prisma: PrismaClient;
  deployments: Pick<DeploymentService, "deployOnPush">;
  environments: Pick<ProjectEnvironments, "closeEnvironment">;
  logger: Logger;
}

/**
 * Pull-request previews, driven by verified GitHub webhooks. For every project
 * of the repository that has previews switched on and deploys the branch the
 * pull request targets: opened/updated → (re)deploy pr-<n>; closed → close it.
 */
export class PreviewService {
  constructor(private readonly deps: PreviewServiceDeps) {}

  async deploy(pr: PullRequestTarget): Promise<string> {
    const projects = await this.projectsFor(pr);
    if (projects.length === 0) return `ignored: no project previews ${pr.owner}/${pr.name} pull requests into ${pr.baseBranch}`;
    let branch: string;
    try {
      branch = validateBranchName(pr.branch);
    } catch {
      return `ignored: branch name "${pr.branch.slice(0, 80)}" isn't one Shipyard builds`;
    }
    const name = previewName(pr.number);
    const results: string[] = [];
    for (const project of projects) {
      try {
        // Its address must not be another project's.
        if (await this.deps.prisma.project.findUnique({ where: { slug: `${name}-${project.slug}` }, select: { id: true } })) {
          results.push(`skipped ${name}-${project.slug}: that address belongs to another project`);
          continue;
        }
        const environment = await this.deps.prisma.environment.upsert({
          where: { projectId_name: { projectId: project.id, name } },
          create: { projectId: project.id, type: "PREVIEW", name, branch, pullRequest: pr.number, title: pr.title },
          update: { branch, title: pr.title, status: "ACTIVE", closedAt: null },
        });
        const result = await this.deps.deployments.deployOnPush(project.id, environment.id);
        results.push(`${result.outcome === "started" ? "deploying" : "queued"} ${name}-${project.slug}`);
      } catch (error) {
        this.deps.logger.warn({ err: error, projectId: project.id, pullRequest: pr.number }, "Preview deploy failed to start");
        results.push(`failed ${name}-${project.slug}: ${errorMessage(error)}`);
      }
    }
    return `#${pr.number} ${branch}: ${results.join("; ")}`;
  }

  /** Takes the previews of a closed (or merged) pull request down. */
  async close(pr: PullRequestTarget): Promise<string> {
    const environments = await this.deps.prisma.environment.findMany({
      where: { ...this.repository(pr), type: "PREVIEW", pullRequest: pr.number, status: "ACTIVE" },
      include: { project: { select: { slug: true } } },
    });
    if (environments.length === 0) return `ignored: no preview for #${pr.number}`;
    const results: string[] = [];
    for (const { project, ...environment } of environments) {
      try {
        await this.deps.environments.closeEnvironment(environment);
        results.push(`closed ${environment.name}-${project.slug}`);
      } catch (error) {
        this.deps.logger.warn({ err: error, environmentId: environment.id }, "Could not close preview");
        results.push(`failed to close ${environment.name}-${project.slug}: ${errorMessage(error)}`);
      }
    }
    return `#${pr.number}: ${results.join("; ")}`;
  }

  async retitle(pr: PullRequestTarget): Promise<string> {
    const { count } = await this.deps.prisma.environment.updateMany({
      where: { ...this.repository(pr), type: "PREVIEW", pullRequest: pr.number },
      data: { title: pr.title },
    });
    return count > 0 ? `#${pr.number}: title updated` : `ignored: no preview for #${pr.number}`;
  }

  private repository(pr: PullRequestTarget) {
    return {
      project: {
        repositoryOwner: { equals: pr.owner, mode: "insensitive" as const },
        repositoryName: { equals: pr.name, mode: "insensitive" as const },
      },
    };
  }

  private projectsFor(pr: PullRequestTarget) {
    return this.deps.prisma.project.findMany({
      where: { ...this.repository(pr).project, previewDeployments: true, branch: pr.baseBranch },
      orderBy: { createdAt: "asc" },
    });
  }
}
