import type { AuditAction, Prisma, PrismaClient } from "../../db/prisma.js";
import type { Logger } from "../../lib/logger.js";

export interface AuditEntry {
  action: AuditAction;
  /** null = Shipyard acting on its own (push, background completion). */
  actorId: string | null;
  /** ownerId: the project's owner, who can see the entry (also after the project is deleted). */
  project?: { id: string; name: string; ownerId: string } | null;
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
      await this.deps.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorId: entry.actorId,
          projectId: entry.project?.id ?? null,
          projectName: entry.project?.name ?? null,
          ownerId: entry.project?.ownerId ?? entry.actorId,
          metadata: entry.metadata ?? {},
        },
      });
    } catch (error) {
      this.deps.logger.error({ err: error, action: entry.action }, "Could not write audit log entry");
    }
  }

  /** What a user may see: activity on their projects (also deleted ones), and their own actions. Newest first. */
  async list(userId: string, options: { projectId?: string; limit: number; before?: number }): Promise<AuditLogView[]> {
    const visible: Prisma.AuditLogWhereInput = { OR: [{ ownerId: userId }, { actorId: userId }] };
    const entries = await this.deps.prisma.auditLog.findMany({
      where: {
        AND: [
          visible,
          ...(options.projectId ? [{ projectId: options.projectId }] : []),
          ...(options.before ? [{ id: { lt: options.before } }] : []),
        ],
      },
      orderBy: { id: "desc" },
      take: options.limit,
      include: { actor: { select: { login: true } } },
    });
    return entries.map(({ actor, actorId: _actorId, ownerId: _ownerId, ...entry }) => ({ ...entry, actor: actor?.login ?? null }));
  }
}
