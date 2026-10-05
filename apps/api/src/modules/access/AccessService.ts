import { type Deployment, type Organization, OrgRole, type Prisma, type PrismaClient, type Project } from "../../db/prisma.js";
import { AppError, ErrorCode, NotFoundError } from "../../lib/errors.js";

/** Higher can do everything lower can. */
const RANK: Record<OrgRole, number> = { VIEWER: 0, DEVELOPER: 1, ADMIN: 2, OWNER: 3 };

export function atLeast(role: OrgRole, need: OrgRole): boolean {
  return RANK[role] >= RANK[need];
}

export type ProjectWithRole = Project & { role: OrgRole; organization: Pick<Organization, "id" | "name" | "personal"> };

/**
 * Every authorization decision in one place. Access to a project comes only
 * from membership in its organization:
 *
 * - not a member → 404, the same as a project that doesn't exist, so ids of
 *   other teams' projects can't be probed;
 * - a member whose role is too low → 403 saying which role is needed.
 */
export class AccessService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Projects the user can see: those of every organization they belong to. */
  visibleProjects(userId: string): Prisma.ProjectWhereInput {
    return { organization: { memberships: { some: { userId } } } };
  }

  async project(projectId: string, userId: string, need: OrgRole = OrgRole.VIEWER): Promise<ProjectWithRole> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: { select: { id: true, name: true, personal: true, memberships: { where: { userId }, select: { role: true } } } },
      },
    });
    const role = project?.organization.memberships[0]?.role;
    if (!project || !role) throw new NotFoundError(`Project not found: ${projectId}`);
    requireRole(role, need, project.organization.name);
    const { memberships: _memberships, ...organization } = project.organization;
    return { ...project, organization, role };
  }

  async deployment(deploymentId: string, userId: string, need: OrgRole = OrgRole.VIEWER): Promise<{ deployment: Deployment; project: ProjectWithRole }> {
    const deployment = await this.prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!deployment) throw new NotFoundError(`Deployment not found: ${deploymentId}`);
    try {
      return { deployment, project: await this.project(deployment.projectId, userId, need) };
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError(`Deployment not found: ${deploymentId}`);
      throw error;
    }
  }

  async organization(organizationId: string, userId: string, need: OrgRole = OrgRole.VIEWER): Promise<Organization & { role: OrgRole }> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { organization: true },
    });
    if (!membership) throw new NotFoundError(`Organization not found: ${organizationId}`);
    requireRole(membership.role, need, membership.organization.name);
    return { ...membership.organization, role: membership.role };
  }

  async personalOrganization(userId: string): Promise<Organization> {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, organization: { personal: true } },
      include: { organization: true },
    });
    if (!membership) throw new NotFoundError("Personal organization not found. Sign in again to create it.");
    return membership.organization;
  }
}

function requireRole(role: OrgRole, need: OrgRole, organizationName: string): void {
  if (!atLeast(role, need)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      `This needs the ${need} role or higher in ${organizationName}; you are ${role}.`,
      { statusCode: 403 },
    );
  }
}
