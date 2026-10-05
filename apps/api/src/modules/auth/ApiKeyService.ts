import type { PrismaClient } from "../../db/prisma.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { hashToken, randomToken } from "./AuthService.js";

export const MAX_API_KEYS_PER_USER = 25;

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ApiKeyServiceDeps {
  prisma: PrismaClient;
  logger: Logger;
  now?: () => Date;
}

/**
 * Personal access tokens for the CLI and scripts. A key acts as its owner, with
 * the same permissions. Only sha256(token) is stored: the token is returned
 * once, by create(), and can't be recovered. Revoking is permanent.
 */
export class ApiKeyService {
  private readonly now: () => Date;

  constructor(private readonly deps: ApiKeyServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(userId: string): Promise<ApiKeyView[]> {
    const keys = await this.deps.prisma.apiKey.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return keys.map(toView);
  }

  /** Returns the token: the only time it is ever available. */
  async create(userId: string, input: { name: string; expiresInDays?: number }): Promise<{ key: ApiKeyView; token: string }> {
    const active = await this.deps.prisma.apiKey.count({ where: { userId, revokedAt: null } });
    if (active >= MAX_API_KEYS_PER_USER) {
      throw new ValidationError(`You can have at most ${MAX_API_KEYS_PER_USER} active API keys. Revoke one first.`);
    }
    const token = `shp_${randomToken()}`;
    const expiresAt =
      input.expiresInDays === undefined ? null : new Date(this.now().getTime() + input.expiresInDays * 86_400_000);
    const key = await this.deps.prisma.apiKey.create({
      data: { userId, name: input.name, prefix: token.slice(0, 12), hash: hashToken(token), expiresAt },
    });
    this.deps.logger.info({ userId, apiKeyId: key.id, name: key.name }, "API key created");
    return { key: toView(key), token };
  }

  /** Idempotent for an already revoked key; another user's key is a 404. */
  async revoke(userId: string, id: string): Promise<void> {
    const key = await this.deps.prisma.apiKey.findFirst({ where: { id, userId } });
    if (!key) throw new NotFoundError(`API key not found: ${id}`);
    if (!key.revokedAt) {
      await this.deps.prisma.apiKey.update({ where: { id }, data: { revokedAt: this.now() } });
      this.deps.logger.info({ userId, apiKeyId: id }, "API key revoked");
    }
  }
}

function toView(key: ApiKeyView & Record<string, unknown>): ApiKeyView {
  const { id, name, prefix, createdAt, lastUsedAt, expiresAt, revokedAt } = key;
  return { id, name, prefix, createdAt, lastUsedAt, expiresAt, revokedAt };
}
