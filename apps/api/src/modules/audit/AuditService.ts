import { AuditAction, type Prisma, type PrismaClient } from "../../db/prisma.js";
import type { Logger } from "../../lib/logger.js";

export interface AuditEntry {
  action: AuditAction;
  /** null = Shipyard acting on its own (push, background completion). */
  actorId: string | null;
  /** Its organization's members can see the entry, also after the project is deleted. */
  project?: { id: string; name: string; organizationId: string } | null;
  /** For entries without a project (team changes); default: the actor's personal organization. */
  organizationId?: string;
  /** Identifiers and names only — never secret values. */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AuditLogView {
  id: number;
  action: AuditAction;
  actor: string | null;
  projectId: string | null;
  projectName: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}

/**
 * The audit trail. Recording is best-effort by design for now: a failed audit
 * write is logged loudly but doesn't undo or block the action it describes.
 */
export class AuditService {
  constructor(private readonly deps: { prisma: PrismaClient; logger: Logger }) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      const organizationId =
        entry.project?.organizationId ?? entry.organizationId ?? (await this.personalOrganizationId(entry.actorId));
      await this.deps.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorId: entry.actorId,
          projectId: entry.project?.id ?? null,
          projectName: entry.project?.name ?? null,
          organizationId,
          metadata: entry.metadata ?? {},
        },
      });
    } catch (error) {
      this.deps.logger.error({ err: error, action: entry.action }, "Could not write audit log entry");
    }
  }

  /**
   * What a user may see: activity in their organizations (including deleted
   * projects), and their own actions anywhere. Newest first.
   */
  async list(
    userId: string,
    options: { projectId?: string; limit: number; before?: number; action?: string[]; actor?: string; q?: string; from?: Date; to?: Date },
  ): Promise<AuditLogView[]> {
    const memberships = await this.deps.prisma.membership.findMany({ where: { userId }, select: { organizationId: true } });
    const visible: Prisma.AuditLogWhereInput = {
      OR: [{ organizationId: { in: memberships.map((m) => m.organizationId) } }, { actorId: userId }],
    };
    const actions = options.action?.filter((action): action is AuditAction => action in AuditAction);
    // Free text: the project name, or anywhere in the details (searched as text; the user's input is a bound parameter).
    const textMatches = options.q
      ? (await this.deps.prisma.$queryRaw<Array<{ id: number }>>`
          SELECT "id" FROM "audit_logs"
          WHERE "projectName" ILIKE ${`%${escapeLike(options.q)}%`} OR "metadata"::text ILIKE ${`%${escapeLike(options.q)}%`}
          ORDER BY "id" DESC LIMIT 5000`).map((row) => row.id)
      : null;
    const entries = await this.deps.prisma.auditLog.findMany({
      where: {
        AND: [
          visible,
          ...(options.projectId ? [{ projectId: options.projectId }] : []),
          ...(options.before ? [{ id: { lt: options.before } }] : []),
          ...(actions ? [{ action: { in: actions } }] : []),
          ...(options.actor
            ? [options.actor.toLowerCase() === "shipyard" ? { actorId: null } : { actor: { login: { equals: options.actor, mode: "insensitive" as const } } }]
            : []),
          ...(textMatches ? [{ id: { in: textMatches } }] : []),
          ...(options.from ? [{ createdAt: { gte: options.from } }] : []),
          ...(options.to ? [{ createdAt: { lte: options.to } }] : []),
        ],
      },
      orderBy: { id: "desc" },
      take: options.limit,
      include: { actor: { select: { login: true } } },
    });
    return entries.map(({ actor, actorId: _actorId, organizationId: _organizationId, ...entry }) => ({
      ...entry,
      actor: actor?.login ?? null,
    }));
  }

  private async personalOrganizationId(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const membership = await this.deps.prisma.membership.findFirst({
      where: { userId, organization: { personal: true } },
      select: { organizationId: true },
    });
    return membership?.organizationId ?? null;
  }
}

/** % and _ typed by the user are literal characters, not wildcards. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
