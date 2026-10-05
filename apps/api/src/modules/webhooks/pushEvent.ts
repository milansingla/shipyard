import { z } from "zod";

const ZERO_SHA = /^0{40}$/;

/** Only the fields Shipyard uses. Everything else in the payload is ignored, never trusted. */
const pushPayloadSchema = z.object({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean().optional(),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string().optional(), name: z.string().optional() }),
  }),
  head_commit: z.object({ message: z.string().optional() }).nullable().optional(),
});

export type PushTarget = { owner: string; name: string; branch: string; commitSha: string };

export type ParsedPush = { kind: "deploy"; target: PushTarget } | { kind: "ignore"; reason: string };

/**
 * Decides whether a push event should deploy anything. Pure, so the rules are
 * unit-tested: tags and branch deletions are ignored; the repository is taken
 * from the payload only to FIND projects — cloning always uses the URL stored
 * on the project.
 */
export function parsePushEvent(payload: unknown): ParsedPush {
  const result = pushPayloadSchema.safeParse(payload);
  if (!result.success) return { kind: "ignore", reason: "not a recognisable push payload" };
  const push = result.data;

  if (!push.ref.startsWith("refs/heads/")) return { kind: "ignore", reason: `not a branch (${push.ref})` };
  if (push.deleted || ZERO_SHA.test(push.after)) return { kind: "ignore", reason: "branch deleted" };

  const owner = push.repository.owner.login ?? push.repository.owner.name;
  if (!owner) return { kind: "ignore", reason: "payload has no repository owner" };

  return {
    kind: "deploy",
    target: { owner, name: push.repository.name, branch: push.ref.slice("refs/heads/".length), commitSha: push.after },
  };
}
