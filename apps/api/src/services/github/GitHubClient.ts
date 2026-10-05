import { z } from "zod";

import { AppError, ErrorCode, NotFoundError, UnauthenticatedError, ValidationError } from "../../lib/errors.js";
import { isValidRepositoryName, isValidRepositoryOwner } from "../git/repositoryUrl.js";

export interface GitHubClientOptions {
  clientId: string;
  clientSecret: string;
  /** Overridable so tests can run a local fake GitHub. */
  oauthBaseUrl?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubRepository {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}

/**
 * Only what sign-in needs. Public repositories can be listed and cloned
 * without any scope; private repositories are out of scope for V2 (they need
 * a GitHub App with per-repository permissions, not a broad `repo` OAuth scope).
 */
export const OAUTH_SCOPE = "read:user";

const tokenResponseSchema = z.union([
  z.object({ access_token: z.string().min(1), token_type: z.string() }),
  // GitHub reports OAuth errors with HTTP 200 and an `error` field.
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});

const repositorySchema = z.object({
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  default_branch: z.string(),
  html_url: z.string(),
  updated_at: z.string(),
});

const branchSchema = z.object({ name: z.string() });

/**
 * The GitHub OAuth web flow + the few REST endpoints Shipyard uses.
 * Every response is validated; every request has a timeout; GitHub failures
 * become AppErrors with codes the API can return as-is.
 */
export class GitHubClient {
  private readonly oauthBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GitHubClientOptions) {
    this.oauthBaseUrl = options.oauthBaseUrl ?? "https://github.com";
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Where to send the browser. `codeChallenge` = base64url(sha256(verifier)) — PKCE. */
  authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL("/login/oauth/authorize", this.oauthBaseUrl);
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: params.redirectUri,
      scope: OAUTH_SCOPE,
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      allow_signup: "false",
    }).toString();
    return url.toString();
  }

  async exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<string> {
    const response = await this.request(new URL("/login/oauth/access_token", this.oauthBaseUrl), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      }),
    });
    if (!response.ok) throw githubError(`token exchange returned HTTP ${response.status}`);

    const body = parseBody(tokenResponseSchema, await response.json(), "token exchange");
    if ("error" in body) {
      // e.g. bad_verification_code: the code expired or was already used.
      throw new AppError(ErrorCode.OAUTH_FAILED, `GitHub sign-in failed: ${body.error}. Please try again.`, {
        statusCode: 400,
      });
    }
    return body.access_token;
  }

  async getUser(token: string): Promise<GitHubUser> {
    const user = parseBody(userSchema, await this.api(token, "/user"), "user");
    return { id: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null };
  }

  /** Repositories the user owns or collaborates on, most recently updated first. */
  async listRepositories(token: string, page: number): Promise<Page<GitHubRepository>> {
    const query = new URLSearchParams({ sort: "updated", per_page: "50", page: String(page) });
    const { body, hasNextPage } = await this.apiPage(token, `/user/repos?${query.toString()}`);
    const repositories = parseBody(z.array(repositorySchema), body, "repositories");
    return {
      hasNextPage,
      items: repositories.map((repo) => ({
        fullName: repo.full_name,
        owner: repo.owner.login,
        name: repo.name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        htmlUrl: repo.html_url,
        updatedAt: repo.updated_at,
      })),
    };
  }

  async listBranches(token: string, owner: string, repo: string, page: number): Promise<Page<string>> {
    // Validated before being placed in a URL path.
    if (!isValidRepositoryOwner(owner) || !isValidRepositoryName(repo)) {
      throw new ValidationError("Invalid repository owner or name.");
    }
    const query = new URLSearchParams({ per_page: "100", page: String(page) });
    const { body, hasNextPage } = await this.apiPage(token, `/repos/${owner}/${repo}/branches?${query.toString()}`);
    return { hasNextPage, items: parseBody(z.array(branchSchema), body, "branches").map((branch) => branch.name) };
  }

  private async api(token: string, path: string): Promise<unknown> {
    return (await this.apiPage(token, path)).body;
  }

  private async apiPage(token: string, path: string): Promise<{ body: unknown; hasNextPage: boolean }> {
    const response = await this.request(new URL(path, this.apiBaseUrl), {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "shipyard",
      },
    });

    if (response.status === 401) {
      throw new UnauthenticatedError("GitHub no longer accepts your sign-in (token revoked or expired). Sign in again.");
    }
    if (response.status === 404) throw new NotFoundError("Not found on GitHub (or not visible to your account).");
    if (response.status === 403 || response.status === 429) {
      throw new AppError(ErrorCode.GITHUB_ERROR, "GitHub rate limit reached. Try again in a few minutes.", {
        statusCode: 503,
      });
    }
    if (!response.ok) throw githubError(`HTTP ${response.status} for ${new URL(path, this.apiBaseUrl).pathname}`);

    return { body: await response.json(), hasNextPage: /rel="next"/.test(response.headers.get("link") ?? "") };
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw githubError(error instanceof Error ? error.message : String(error), error);
    }
  }
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown, what: string): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw githubError(`unexpected ${what} response`);
  return result.data;
}

function githubError(detail: string, cause?: unknown): AppError {
  return new AppError(ErrorCode.GITHUB_ERROR, `Could not reach GitHub: ${detail}.`, { statusCode: 502, cause });
}
