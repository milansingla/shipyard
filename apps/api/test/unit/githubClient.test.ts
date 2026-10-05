import { describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import { GitHubClient } from "../../src/services/github/GitHubClient.js";

interface Call {
  url: string;
  init: RequestInit;
}

function client(respond: (url: URL) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const github = new GitHubClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url: url.toString(), init });
      return respond(url);
    }) as typeof fetch,
  });
  return { github, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

describe("GitHubClient", () => {
  it("builds an authorize URL with state, PKCE and the minimal scope", () => {
    const url = new URL(
      client(() => json({})).github.authorizeUrl({ state: "s", codeChallenge: "c", redirectUri: "http://x/cb" }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-id",
      state: "s",
      code_challenge: "c",
      code_challenge_method: "S256",
      scope: "read:user",
      redirect_uri: "http://x/cb",
    });
  });

  it("exchanges a code, sending the PKCE verifier and client secret in the body", async () => {
    const { github, calls } = client(() => json({ access_token: "gho_1", token_type: "bearer" }));
    expect(await github.exchangeCode({ code: "abc", codeVerifier: "v", redirectUri: "http://x/cb" })).toBe("gho_1");

    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ code: "abc", code_verifier: "v", client_secret: "client-secret" });
    // The secret goes in the body, never in a URL that could end up in logs.
    expect(calls[0]?.url).not.toContain("client-secret");
  });

  it("turns GitHub's HTTP-200 OAuth error into OAUTH_FAILED", async () => {
    const { github } = client(() => json({ error: "bad_verification_code", error_description: "expired" }));
    await expect(github.exchangeCode({ code: "x", codeVerifier: "v", redirectUri: "r" })).rejects.toMatchObject({
      code: ErrorCode.OAUTH_FAILED,
      statusCode: 400,
    });
  });

  it("maps the user and sends the token as a bearer header", async () => {
    const { github, calls } = client(() => json({ id: 42, login: "octocat", name: null, avatar_url: "https://a/x.png" }));
    expect(await github.getUser("gho_1")).toEqual({ id: 42, login: "octocat", name: null, avatarUrl: "https://a/x.png" });
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer gho_1");
  });

  it("lists repositories and detects the next page from the Link header", async () => {
    const repo = {
      full_name: "octocat/hello",
      name: "hello",
      owner: { login: "octocat" },
      private: false,
      default_branch: "main",
      html_url: "https://github.com/octocat/hello",
      updated_at: "2026-10-01T00:00:00Z",
    };
    const { github, calls } = client(() =>
      json([repo], { headers: { link: '<https://api.github.com/user/repos?page=3>; rel="next"' } }),
    );
    const page = await github.listRepositories("t", 2);
    expect(page).toEqual({
      hasNextPage: true,
      items: [
        {
          fullName: "octocat/hello",
          owner: "octocat",
          name: "hello",
          private: false,
          defaultBranch: "main",
          htmlUrl: "https://github.com/octocat/hello",
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    expect(calls[0]?.url).toContain("page=2");
  });

  it("validates owner/repo before putting them in a URL path", async () => {
    const { github, calls } = client(() => json([]));
    await expect(github.listBranches("t", "..", "x", 1)).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    await expect(github.listBranches("t", "a", "b/../../user", 1)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, ErrorCode.UNAUTHENTICATED, 401],
    [404, ErrorCode.NOT_FOUND, 404],
    [403, ErrorCode.GITHUB_ERROR, 503],
    [500, ErrorCode.GITHUB_ERROR, 502],
  ])("GitHub HTTP %d → %s (%d)", async (status, code, statusCode) => {
    const { github } = client(() => json({ message: "x" }, { status }));
    await expect(github.getUser("t")).rejects.toMatchObject({ code, statusCode });
  });

  it("rejects responses that don't match the expected shape", async () => {
    const { github } = client(() => json({ login: "no-id" }));
    await expect(github.getUser("t")).rejects.toMatchObject({ code: ErrorCode.GITHUB_ERROR });
  });

  it("reports network failures as GITHUB_ERROR", async () => {
    const { github } = client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(github.getUser("t")).rejects.toMatchObject({ code: ErrorCode.GITHUB_ERROR, statusCode: 502 });
  });
});
