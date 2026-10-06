import { Router } from "express";
import { z } from "zod";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { API_KEY_SCOPES } from "../../middleware/apiKeyScopes.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { ServiceAccountService } from "./ServiceAccountService.js";
import type { TeamService } from "./TeamService.js";

const nameSchema = z.strictObject({ name: z.string().trim().min(1).max(60) });
const memberSchema = z.strictObject({ login: z.string().trim().min(1).max(100) });
const grantSchema = z.strictObject({ role: z.enum(["VIEWER", "DEVELOPER", "ADMIN"]) });
const teamProjectParams = z.object({ id: z.uuid(), projectId: z.uuid() });
const teamMemberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const accountSchema = z.strictObject({
  name: z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "must be a lowercase name like ci or deploy-bot"),
  role: z.enum(["VIEWER", "DEVELOPER", "ADMIN"]),
});
const keySchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  expiresInDays: z.int().min(1).max(365).optional(),
  scopes: z.array(z.enum(API_KEY_SCOPES)).max(3).optional(),
});
const keyParams = z.object({ id: z.uuid(), keyId: z.uuid() });

export function createTeamRouter(teams: TeamService, serviceAccounts: ServiceAccountService): Router {
  const router = Router();

  router.get("/organizations/:id/teams", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await teams.list(id, requireUser(req).id));
  });

  router.post("/organizations/:id/teams", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await teams.create(id, requireUser(req).id, parseInput(nameSchema, req.body, "team").name), 201);
  });

  router.delete("/teams/:id", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "team id");
    await teams.delete(id, requireUser(req).id);
    res.status(204).end();
  });

  router.post("/teams/:id/members", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "team id");
    await teams.addMember(id, requireUser(req).id, parseInput(memberSchema, req.body, "member").login);
    res.status(204).end();
  });

  router.delete("/teams/:id/members/:userId", async (req, res) => {
    const { id, userId } = parseInput(teamMemberParams, req.params, "member");
    await teams.removeMember(id, requireUser(req).id, userId);
    res.status(204).end();
  });

  router.put("/teams/:id/projects/:projectId", async (req, res) => {
    const { id, projectId } = parseInput(teamProjectParams, req.params, "grant");
    await teams.grant(id, requireUser(req).id, projectId, parseInput(grantSchema, req.body, "grant").role);
    res.status(204).end();
  });

  router.delete("/teams/:id/projects/:projectId", async (req, res) => {
    const { id, projectId } = parseInput(teamProjectParams, req.params, "grant");
    await teams.revoke(id, requireUser(req).id, projectId);
    res.status(204).end();
  });

  router.get("/organizations/:id/service-accounts", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await serviceAccounts.list(id, requireUser(req).id));
  });

  router.post("/organizations/:id/service-accounts", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await serviceAccounts.create(id, requireUser(req).id, parseInput(accountSchema, req.body, "service account")), 201);
  });

  router.delete("/service-accounts/:id", async (req, res) => {
    const { id } = parseInput(idParamsSchema, req.params, "service account id");
    await serviceAccounts.delete(id, requireUser(req).id);
    res.status(204).end();
  });

  /** 201 with { key, token }: the token is shown this once. From the dashboard only. */
  router.post("/service-accounts/:id/keys", async (req, res) => {
    const user = requireUser(req);
    if (req.authMethod !== "session") {
      throw new AppError(ErrorCode.FORBIDDEN, "API keys can only be created from the dashboard.", { statusCode: 403 });
    }
    const { id } = parseInput(idParamsSchema, req.params, "service account id");
    sendData(res, await serviceAccounts.createKey(id, user.id, parseInput(keySchema, req.body, "API key")), 201);
  });

  router.delete("/service-accounts/:id/keys/:keyId", async (req, res) => {
    const { id, keyId } = parseInput(keyParams, req.params, "API key");
    await serviceAccounts.revokeKey(id, requireUser(req).id, keyId);
    res.status(204).end();
  });

  return router;
}
