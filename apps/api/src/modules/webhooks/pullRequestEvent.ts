import { z } from "zod";

/** Only the fields Shipyard uses. Everything else in the payload is ignored, never trusted. */
const pullRequestPayloadSchema = z.object({
  action: z.string(),
  number: z.int().positive(),
  pull_request: z.object({
    title: z.string().optional(),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
    base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

export interface PullRequestTarget {
  owner: string;
  name: string;
  number: number;
  /** The branch with the pull request's changes. */
  branch: string;
  /** The branch it would merge into. */
  baseBranch: string;
  title: string;
}

export type ParsedPullRequest =
  | { kind: "deploy" | "close" | "retitle"; target: PullRequestTarget }
  | { kind: "ignore"; reason: string };

const DEPLOY_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/**
 * Decides what a pull_request event means for previews. Pure, so the rules
 * are unit-tested. Pull requests from forks are never built: their code
 * comes from outside the repository, and building it runs it on this server.
 */
export function parsePullRequestEvent(payload: unknown): ParsedPullRequest {
  const result = pullRequestPayloadSchema.safeParse(payload);
  if (!result.success) return { kind: "ignore", reason: "not a recognisable pull_request payload" };
  const { action, number, pull_request: pr, repository } = result.data;

  if (!pr.head.repo || pr.head.repo.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase()) {
    return { kind: "ignore", reason: "pull requests from forks are never built" };
  }
  const target: PullRequestTarget = {
    owner: repository.owner.login,
    name: repository.name,
    number,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    title: (pr.title ?? "").slice(0, 200),
  };
  if (DEPLOY_ACTIONS.has(action)) return { kind: "deploy", target };
  if (action === "closed") return { kind: "close", target };
  if (action === "edited") return { kind: "retitle", target };
  return { kind: "ignore", reason: `nothing to do for "${action}"` };
}
