import type { OrgRole } from "./types";

const RANK: Record<OrgRole, number> = { VIEWER: 0, DEVELOPER: 1, ADMIN: 2, OWNER: 3 };

/** Mirrors the API's rule: a role can do everything the roles below it can. */
export function can(role: OrgRole | undefined, need: OrgRole): boolean {
  return role !== undefined && RANK[role] >= RANK[need];
}
