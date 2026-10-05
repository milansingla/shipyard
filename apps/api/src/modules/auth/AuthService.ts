import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { PrismaClient, User } from "../../db/prisma.js";
import { AppError, ErrorCode, UnauthenticatedError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import type { SecretBox } from "../../lib/secretBox.js";
import type { GitHubClient } from "../../services/github/GitHubClient.js";

/** What the API exposes about a user. Deliberately excludes the GitHub token. */
export interface AuthUser {
  id: string;
  /** String, not number: JSON numbers lose precision past 2^53, and BigInt isn't JSON. */
  githubId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface AuthServiceDeps {
  prisma: PrismaClient;
  github: Pick<GitHubClient, "authorizeUrl" | "exchangeCode" | "getUser">;
  secretBox: SecretBox;
  /** Absolute URL of GET /api/auth/github/callback; must match the GitHub OAuth App. */
  redirectUri: string;
  sessionTtlMs: number;
  /** Lower-cased GitHub logins allowed to sign in, or "*". */
  allowedUsers: readonly string[] | "*";
  logger: Logger;
  now?: () => Date;
}

export interface CompleteLoginInput {
  code?: string;
  state?: string;
  /** Set by GitHub when the user cancels or the app is misconfigured. */
  error?: string;
  /** Value of the short-lived login cookie set by startLogin(). */
  loginCookie?: string;
}

/** 32 random bytes, base64url: 43 chars. Also a valid PKCE verifier (43–128 unreserved chars). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** API keys: a recognisable prefix (secret scanners and people can spot one) + a session-strength token. */
export const API_KEY_PATTERN = /^shp_[A-Za-z0-9_-]{43}$/;

/**
 * GitHub OAuth web flow + server-side sessions.
 *
 * Login CSRF: `state` is random per attempt and must come back identical in the
 * callback AND match the httpOnly cookie set on this browser — so an attacker
 * cannot complete a sign-in in someone else's browser.
 * PKCE: the code is useless without the verifier, which never leaves the server
 * and this browser's cookie.
 * Sessions: the cookie carries a random token; PostgreSQL stores sha256(token).
 */
export class AuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  startLogin(): { authorizeUrl: string; loginCookie: string } {
    const state = randomToken();
    const verifier = randomToken();
    const authorizeUrl = this.deps.github.authorizeUrl({
      state,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      redirectUri: this.deps.redirectUri,
    });
    return { authorizeUrl, loginCookie: `${state}.${verifier}` };
  }

  async completeLogin(input: CompleteLoginInput): Promise<{ sessionToken: string; expiresAt: Date; user: AuthUser }> {
    if (input.error !== undefined) throw oauthFailed("GitHub sign-in was cancelled or denied.");

    const [expectedState, verifier] = (input.loginCookie ?? "").split(".");
    if (!expectedState || !verifier || !TOKEN_PATTERN.test(expectedState) || !TOKEN_PATTERN.test(verifier)) {
      throw oauthFailed("Your sign-in attempt expired or was started in another browser. Please sign in again.");
    }
    if (!input.code || !input.state || !safeEqual(input.state, expectedState)) {
      throw oauthFailed("Sign-in could not be verified (state mismatch). Please sign in again.");
    }

    const accessToken = await this.deps.github.exchangeCode({
      code: input.code,
      codeVerifier: verifier,
      redirectUri: this.deps.redirectUri,
    });
    const githubUser = await this.deps.github.getUser(accessToken);
    if (!this.isAllowed(githubUser.login)) {
      this.deps.logger.warn({ login: githubUser.login }, "Sign-in refused: not in SHIPYARD_ALLOWED_GITHUB_USERS");
      throw new AppError(ErrorCode.FORBIDDEN, `GitHub user "${githubUser.login}" is not allowed to sign in to this Shipyard.`, {
        statusCode: 403,
      });
    }

    const profile = { login: githubUser.login, name: githubUser.name, avatarUrl: githubUser.avatarUrl };
    const githubAccessToken = this.deps.secretBox.encrypt(accessToken);
    const user = await this.deps.prisma.user.upsert({
      where: { githubId: BigInt(githubUser.id) },
      create: { githubId: BigInt(githubUser.id), ...profile, githubAccessToken },
      update: { ...profile, githubAccessToken },
    });

    const sessionToken = randomToken();
    const expiresAt = new Date(this.now().getTime() + this.deps.sessionTtlMs);
    await this.deps.prisma.session.create({ data: { id: hashToken(sessionToken), userId: user.id, expiresAt } });

    this.deps.logger.info({ userId: user.id, login: user.login }, "User signed in");
    return { sessionToken, expiresAt, user: toAuthUser(user) };
  }

  /** The signed-in user for a session cookie value, or null. Never throws for bad input. */
  async authenticate(sessionToken: string | undefined): Promise<AuthUser | null> {
    if (!sessionToken || !TOKEN_PATTERN.test(sessionToken)) return null;

    const session = await this.deps.prisma.session.findUnique({
      where: { id: hashToken(sessionToken) },
      include: { user: true },
    });
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      await this.deps.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }
    // Re-checked on every request: removing someone from the allowlist cuts them off immediately.
    if (!this.isAllowed(session.user.login)) return null;
    return toAuthUser(session.user);
  }

  /**
   * The user for an API key (`Authorization: Bearer shp_…`), or null. Revoked,
   * expired and unknown keys are all simply "not signed in"; the allowlist is
   * re-checked exactly as for sessions.
   */
  async authenticateApiKey(token: string | undefined): Promise<AuthUser | null> {
    if (!token || !API_KEY_PATTERN.test(token)) return null;
    const key = await this.deps.prisma.apiKey.findUnique({ where: { hash: hashToken(token) }, include: { user: true } });
    const now = this.now();
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= now)) return null;
    if (!this.isAllowed(key.user.login)) return null;
    // At most one write a minute per key: "last used" doesn't need to be exact.
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
      await this.deps.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
    }
    return toAuthUser(key.user);
  }

  /** Idempotent: signing out twice, or with an unknown cookie, is fine. */
  async logout(sessionToken: string | undefined): Promise<void> {
    if (!sessionToken || !TOKEN_PATTERN.test(sessionToken)) return;
    await this.deps.prisma.session.deleteMany({ where: { id: hashToken(sessionToken) } });
  }

  /** The user's GitHub token, decrypted, for calls made on their behalf. Never send it to a client. */
  async githubToken(userId: string): Promise<string> {
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthenticatedError();
    try {
      return this.deps.secretBox.decrypt(user.githubAccessToken);
    } catch {
      // Typically SHIPYARD_SECRET_KEY changed. Signing in again stores a fresh token.
      throw new UnauthenticatedError("Your stored GitHub sign-in can no longer be read. Sign in again.");
    }
  }

  private isAllowed(login: string): boolean {
    return this.deps.allowedUsers === "*" || this.deps.allowedUsers.includes(login.toLowerCase());
  }

  async deleteExpiredSessions(): Promise<number> {
    const { count } = await this.deps.prisma.session.deleteMany({ where: { expiresAt: { lte: this.now() } } });
    return count;
  }
}

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    githubId: user.githubId.toString(),
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function oauthFailed(message: string): AppError {
  return new AppError(ErrorCode.OAUTH_FAILED, message, { statusCode: 400 });
}
