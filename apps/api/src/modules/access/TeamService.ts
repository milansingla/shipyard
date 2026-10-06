import { OrgRole, type PrismaClient, isUniqueViolation } from "../../db/prisma.js";
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { AuditService } from "../audit/AuditService.js";
import type { AccessService } from "./AccessService.js";

export interface TeamView {
  id: string;
  name: string;
  members: Array<{ id: string; login: string }>;
  grants: Array<{ projectId: string; projectName: string; role: OrgRole }>;
}

/**
 * Teams inside an organization: groups of its members granted a role on
 * specific projects (VIEWER, DEVELOPER or ADMIN, never OWNER). Effective
 * role = the higher of organization role and team grants (AccessService).
 * Anyone in the organization sees its teams; ADMINs change them.
 */
export class TeamService {
  constructor(private readonly deps: { prisma: PrismaClient; access: AccessService; audit: Pick<AuditService, "record"> }) {}

  async list(organizationId: string, userId: string): Promise<TeamView[]> {
    await this.deps.access.organization(organizationId, userId, OrgRole.VIEWER);
    const teams = await this.deps.prisma.team.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      include: { members: { include: { user: { select: { id: true, login: true } } } }, grants: { include: { project: { select: { name: true } } } } },
    });
    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      members: team.members.map((member) => member.user).sort((a, b) => a.login.localeCompare(b.login)),
      grants: team.grants.map((grant) => ({ projectId: grant.projectId, projectName: grant.project.name, role: grant.role })),
    }));
  }

  async create(organizationId: string, userId: string, name: string): Promise<TeamView> {
    await this.deps.access.organization(organizationId, userId, OrgRole.ADMIN);
    try {
      const team = await this.deps.prisma.team.create({ data: { organizationId, name } });
      await this.deps.audit.record({ action: "TEAM_CREATED", actorId: userId, organizationId, metadata: { team: name } });
      return { id: team.id, name: team.name, members: [], grants: [] };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `There is already a team named "${name}".`);
      throw error;
    }
  }

  async delete(teamId: string, userId: string): Promise<void> {
    const team = await this.find(teamId, userId);
    await this.deps.prisma.team.delete({ where: { id: team.id } });
    await this.deps.audit.record({ action: "TEAM_DELETED", actorId: userId, organizationId: team.organizationId, metadata: { team: team.name } });
  }

  /** Adds an existing member of the organization (by login) to the team. */
  async addMember(teamId: string, userId: string, login: string): Promise<void> {
    const team = await this.find(teamId, userId);
    const membership = await this.deps.prisma.membership.findFirst({
      where: { organizationId: team.organizationId, user: { login: { equals: login, mode: "insensitive" } } },
    });
    if (!membership) throw new ValidationError(`${login} isn't a member of this organization: add them there first.`);
    await this.deps.prisma.teamMember.upsert({
      where: { teamId_userId: { teamId, userId: membership.userId } },
      create: { teamId, userId: membership.userId },
      update: {},
    });
    await this.changed(team, userId, { added: login });
  }

  async removeMember(teamId: string, userId: string, memberId: string): Promise<void> {
    const team = await this.find(teamId, userId);
    await this.deps.prisma.teamMember.deleteMany({ where: { teamId, userId: memberId } });
    await this.changed(team, userId, { removed: memberId });
  }

  async grant(teamId: string, userId: string, projectId: string, role: OrgRole): Promise<void> {
    const team = await this.find(teamId, userId);
    if (role === OrgRole.OWNER) throw new ValidationError("A team can be granted VIEWER, DEVELOPER or ADMIN; owning is an organization role.");
    const project = await this.deps.prisma.project.findFirst({ where: { id: projectId, organizationId: team.organizationId }, select: { name: true } });
    if (!project) throw new NotFoundError(`Project not found in this organization: ${projectId}`);
    await this.deps.prisma.teamProjectGrant.upsert({
      where: { teamId_projectId: { teamId, projectId } },
      create: { teamId, projectId, role },
      update: { role },
    });
    await this.changed(team, userId, { project: project.name, role });
  }

  async revoke(teamId: string, userId: string, projectId: string): Promise<void> {
    const team = await this.find(teamId, userId);
    await this.deps.prisma.teamProjectGrant.deleteMany({ where: { teamId, projectId } });
    await this.changed(team, userId, { revoked: projectId });
  }

  private async changed(team: { organizationId: string; name: string }, userId: string, metadata: Record<string, string>) {
    await this.deps.audit.record({ action: "TEAM_CHANGED", actorId: userId, organizationId: team.organizationId, metadata: { team: team.name, ...metadata } });
  }

  /** The team, if the user is an ADMIN of its organization (others: 404 or 403). */
  private async find(teamId: string, userId: string) {
    const team = await this.deps.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundError(`Team not found: ${teamId}`);
    try {
      await this.deps.access.organization(team.organizationId, userId, OrgRole.ADMIN);
    } catch (error) {
      throw error instanceof NotFoundError ? new NotFoundError(`Team not found: ${teamId}`) : error;
    }
    return team;
  }
}
