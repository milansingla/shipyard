import { type Organization, OrgRole, type PrismaClient, isUniqueViolation } from "../../db/prisma.js";
import { AppError, ConflictError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { toDockerSlug } from "../../services/docker/naming.js";
import type { AuditService } from "../audit/AuditService.js";
import type { AccessService } from "./AccessService.js";

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  personal: boolean;
  /** The current user's role. */
  role: OrgRole;
  members: number;
}

export interface MemberView {
  userId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  since: Date;
}

export interface OrganizationServiceDeps {
  prisma: PrismaClient;
  access: AccessService;
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

/**
 * Teams. Rules, enforced here:
 * - ADMINs manage DEVELOPER and VIEWER members; only OWNERs can grant,
 *   change or remove OWNER/ADMIN.
 * - An organization always keeps at least one OWNER.
 * - Personal organizations have exactly one member: create a team to share.
 * - Members are added by GitHub login, and must have signed in once (and so
 *   be on SHIPYARD_ALLOWED_GITHUB_USERS).
 */
export class OrganizationService {
  constructor(private readonly deps: OrganizationServiceDeps) {}

  async list(userId: string): Promise<OrganizationView[]> {
    const memberships = await this.deps.prisma.membership.findMany({
      where: { userId },
      include: { organization: { include: { _count: { select: { memberships: true } } } } },
      orderBy: [{ organization: { personal: "desc" } }, { organization: { name: "asc" } }],
    });
    return memberships.map(({ role, organization: { _count, ...organization } }) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      personal: organization.personal,
      role,
      members: _count.memberships,
    }));
  }

  /** Creates a team with the creator as its OWNER. */
  async create(userId: string, name: string): Promise<OrganizationView> {
    const slug = toDockerSlug(name);
    if (slug.startsWith("user-")) throw new ValidationError(`Team names can't start with "user-": those are personal organizations.`);
    let organization: Organization;
    try {
      organization = await this.deps.prisma.organization.create({
        data: { name, slug, memberships: { create: { userId, role: OrgRole.OWNER } } },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `A team named "${slug}" already exists.`);
      throw error;
    }
    await this.deps.audit.record({ action: "ORGANIZATION_CREATED", actorId: userId, organizationId: organization.id, metadata: { name } });
    return { ...organization, role: OrgRole.OWNER, members: 1 };
  }

  async members(organizationId: string, userId: string): Promise<MemberView[]> {
    await this.deps.access.organization(organizationId, userId);
    const memberships = await this.deps.prisma.membership.findMany({
      where: { organizationId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
    return memberships.map(({ user, role, createdAt }) => ({
      userId: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role,
      since: createdAt,
    }));
  }

  async addMember(organizationId: string, userId: string, input: { login: string; role: OrgRole }): Promise<MemberView> {
    const organization = await this.deps.access.organization(organizationId, userId, OrgRole.ADMIN);
    if (organization.personal) throw new ValidationError("A personal organization has one member. Create a team to work with others.");
    this.assertMayGrant(organization.role, input.role);

    const member = await this.deps.prisma.user.findFirst({ where: { login: { equals: input.login, mode: "insensitive" } } });
    if (!member) throw new NotFoundError(`No Shipyard user "${input.login}". They need to sign in once first.`);
    try {
      const membership = await this.deps.prisma.membership.create({ data: { organizationId, userId: member.id, role: input.role } });
      await this.deps.audit.record({
        action: "MEMBER_ADDED",
        actorId: userId,
        organizationId,
        metadata: { login: member.login, role: input.role },
      });
      return { userId: member.id, login: member.login, name: member.name, avatarUrl: member.avatarUrl, role: membership.role, since: membership.createdAt };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCode.MEMBER_EXISTS, `${member.login} is already a member.`);
      throw error;
    }
  }

  async changeRole(organizationId: string, userId: string, memberUserId: string, role: OrgRole): Promise<void> {
    const organization = await this.deps.access.organization(organizationId, userId, OrgRole.ADMIN);
    const current = await this.membership(organizationId, memberUserId);
    this.assertMayGrant(organization.role, current.role); // may touch this member at all
    this.assertMayGrant(organization.role, role); // and give them this role
    if (current.role === OrgRole.OWNER && role !== OrgRole.OWNER) await this.assertNotLastOwner(organizationId);
    await this.deps.prisma.membership.update({
      where: { organizationId_userId: { organizationId, userId: memberUserId } },
      data: { role },
    });
    await this.deps.audit.record({
      action: "MEMBER_ROLE_CHANGED",
      actorId: userId,
      organizationId,
      metadata: { login: current.user.login, from: current.role, to: role },
    });
  }

  /** ADMIN+, or anyone leaving on their own. */
  async removeMember(organizationId: string, userId: string, memberUserId: string): Promise<void> {
    const leaving = memberUserId === userId;
    const organization = await this.deps.access.organization(organizationId, userId, leaving ? OrgRole.VIEWER : OrgRole.ADMIN);
    const current = await this.membership(organizationId, memberUserId);
    if (organization.personal) throw new ValidationError("You can't leave your personal organization.");
    if (!leaving) this.assertMayGrant(organization.role, current.role);
    if (current.role === OrgRole.OWNER) await this.assertNotLastOwner(organizationId);
    // Their teams go too: a grant left behind would come back if they were ever re-added.
    await this.deps.prisma.$transaction([
      this.deps.prisma.teamMember.deleteMany({ where: { userId: memberUserId, team: { organizationId } } }),
      this.deps.prisma.membership.delete({ where: { organizationId_userId: { organizationId, userId: memberUserId } } }),
    ]);
    await this.deps.audit.record({
      action: "MEMBER_REMOVED",
      actorId: userId,
      organizationId,
      metadata: { login: current.user.login, role: current.role },
    });
  }

  private async membership(organizationId: string, userId: string) {
    const membership = await this.deps.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { user: true },
    });
    if (!membership) throw new NotFoundError("Member not found.");
    return membership;
  }

  /** Only OWNERs deal in OWNER/ADMIN; ADMINs only in DEVELOPER/VIEWER. */
  private assertMayGrant(actorRole: OrgRole, role: OrgRole): void {
    const privileged = role === OrgRole.OWNER || role === OrgRole.ADMIN;
    if (privileged && actorRole !== OrgRole.OWNER) {
      throw new AppError(ErrorCode.FORBIDDEN, "Only an OWNER can grant, change or remove the OWNER and ADMIN roles.", {
        statusCode: 403,
      });
    }
  }

  private async assertNotLastOwner(organizationId: string): Promise<void> {
    const owners = await this.deps.prisma.membership.count({ where: { organizationId, role: OrgRole.OWNER } });
    if (owners <= 1) throw new ConflictError(ErrorCode.LAST_OWNER, "An organization needs at least one OWNER. Make someone else OWNER first.");
  }
}
