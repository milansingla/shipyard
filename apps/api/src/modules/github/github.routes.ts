import { Router } from "express";
import { z } from "zod";

import { sendData } from "../../lib/http.js";
import { parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { GitHubClient } from "../../services/github/GitHubClient.js";
import type { AuthService } from "../auth/AuthService.js";

const pageQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(100).default(1) });
const repositoryParamsSchema = z.object({ owner: z.string().min(1).max(39), repo: z.string().min(1).max(100) });

/**
 * Repository and branch pickers for the "new project" flow. Calls GitHub with
 * the signed-in user's own token, so users only ever see what GitHub shows them.
 */
export function createGitHubRouter(
  auth: Pick<AuthService, "githubToken">,
  github: Pick<GitHubClient, "listRepositories" | "listBranches">,
): Router {
  const router = Router();

  router.get("/github/repos", async (req, res) => {
    const user = requireUser(req);
    const { page } = parseInput(pageQuerySchema, req.query, "query");
    const result = await github.listRepositories(await auth.githubToken(user.id), page);
    sendData(res, {
      hasNextPage: result.hasNextPage,
      // Private repositories need a GitHub App to clone (planned); listed so the UI can explain.
      items: result.items.map((repo) => ({
        ...repo,
        repositoryUrl: `https://github.com/${repo.fullName}`,
        deployable: !repo.private,
      })),
    });
  });

  router.get("/github/repos/:owner/:repo/branches", async (req, res) => {
    const user = requireUser(req);
    const { owner, repo } = parseInput(repositoryParamsSchema, req.params, "repository");
    const { page } = parseInput(pageQuerySchema, req.query, "query");
    sendData(res, await github.listBranches(await auth.githubToken(user.id), owner, repo, page));
  });

  return router;
}
