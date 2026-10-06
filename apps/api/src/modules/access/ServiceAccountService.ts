import { OrgRole, type PrismaClient } from "../../db/prisma.js";
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { AuditService } from "../audit/AuditService.js";
import type { ApiKeyService, ApiKeyView } from "../auth/ApiKeyService.js";
import type { AccessService } from "./AccessService.js";

export interface ServiceAccountView {
  id: string;
  login: string;
  name: string;
  role: OrgRole;
  keys: ApiKeyView[];
}

/**
 * Service accounts: automation identities of one organization (CI, scripts).
 * One is a member with a fixed role (never OWNER) and authenticates only with
 * API keys, which its organization's ADMINs create, scoped as they choose.
 * It has no GitHub account and can never sign in.
 */
export class ServiceAccountService {
  constructor(
    private readonly deps: { prisma: PrismaClient; access: AccessService; audit: Pick<AuditService, "record">; apiKeys: Pick<ApiKeyService, "create" | "list" | "revoke"> },
  ) {}

  async list(organizationId: string, userId: string): Promise<ServiceAccountView[]> {
    await this.deps.access.organization(organizationId, userId, OrgRole.ADMIN);
    const memberships = await this.deps.prisma.membership.findMany({
      where: { organizationId, user: { kind: "SERVICE_ACCOUNT" } },
      include: { user: true },
      orderBy: { user: { login: "asc" } },
    });
    return Promise.all(
      memberships.map(async ({ user, role }) => ({ id: user.id, login: user.login, name: user.name ?? user.login, role, keys: await this.deps.apiKeys.list(user.id) })),
    );
  }

  async create(organizationId: string, userId: string, input: { name: string; role: OrgRole }): Promise<ServiceAccountView> {
    await this.deps.access.organization(organizationId, userId, OrgRole.ADMIN);
    if (input.role === OrgRole.OWNER) throw new ValidationError("A service account can be VIEWER, DEVELOPER or ADMIN, never OWNER.");
    const login = `${input.name}[bot]`;
    const taken = await this.deps.prisma.membership.findFirst({ where: { organizationId, user: { login } }, select: { userId: true } });
    if (taken) throw new ConflictError(ErrorCode.PROJECT_ALREADY_EXISTS, `This organization already has a service account named ${input.name}.`);
    const account = await this.deps.prisma.user.create({
      data: { kind: "SERVICE_ACCOUNT", login, name: input.name, memberships: { create: { organizationId, role: input.role } } },
    });
    await this.deps.audit.record({ action: "SERVICE_ACCOUNT_CREATED", actorId: userId, organizationId, metadata: { serviceAccount: login, role: input.role } });
    return { id: account.id, login, name: input.name, role: input.role, keys: [] };
  }

  async delete(accountId: string, userId: string): Promise<void> {
    const { account, organizationId } = await this.find(accountId, userId);
    await this.deps.prisma.user.delete({ where: { id: account.id } }); // its membership and keys go with it
    await this.deps.audit.record({ action: "SERVICE_ACCOUNT_DELETED", actorId: userId, organizationId, metadata: { serviceAccount: account.login } });
  }

  /** The token is returned this once. */
  async createKey(accountId: string, userId: string, input: { name: string; expiresInDays?: number; scopes?: readonly string[] }) {
    const { account } = await this.find(accountId, userId);
    return this.deps.apiKeys.create(account.id, input, userId);
  }

  async revokeKey(accountId: string, userId: string, keyId: string): Promise<void> {
    const { account } = await this.find(accountId, userId);
    await this.deps.apiKeys.revoke(account.id, keyId);
  }

  private async find(accountId: string, userId: string) {
    const membership = await this.deps.prisma.membership.findFirst({
      where: { userId: accountId, user: { kind: "SERVICE_ACCOUNT" } },
      include: { user: true },
    });
    if (!membership) throw new NotFoundError(`Service account not found: ${accountId}`);
    try {
      await this.deps.access.organization(membership.organizationId, userId, OrgRole.ADMIN);
    } catch (error) {
      throw error instanceof NotFoundError ? new NotFoundError(`Service account not found: ${accountId}`) : error;
    }
    return { account: membership.user, organizationId: membership.organizationId };
  }
}
