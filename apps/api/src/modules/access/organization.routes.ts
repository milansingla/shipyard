import { Router } from "express";
import { z } from "zod";

import { OrgRole } from "../../db/prisma.js";
import { sendData } from "../../lib/http.js";
import { idParamsSchema, parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { OrganizationService } from "./OrganizationService.js";

const roleSchema = z.enum([OrgRole.OWNER, OrgRole.ADMIN, OrgRole.DEVELOPER, OrgRole.VIEWER]);
const memberParamsSchema = z.object({ id: z.uuid(), userId: z.uuid() });

export function createOrganizationRouter(organizations: OrganizationService): Router {
  const router = Router();

  router.get("/organizations", async (req, res) => {
    sendData(res, await organizations.list(requireUser(req).id));
  });

  router.post("/organizations", async (req, res) => {
    const user = requireUser(req);
    const { name } = parseInput(z.strictObject({ name: z.string().trim().min(1).max(64) }), req.body, "team");
    sendData(res, await organizations.create(user.id, name), 201);
  });

  router.get("/organizations/:id/members", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    sendData(res, await organizations.members(id, user.id));
  });

  router.post("/organizations/:id/members", async (req, res) => {
    const user = requireUser(req);
    const { id } = parseInput(idParamsSchema, req.params, "organization id");
    const input = parseInput(
      z.strictObject({ login: z.string().trim().min(1).max(39), role: roleSchema.default(OrgRole.DEVELOPER) }),
      req.body,
      "member",
    );
    sendData(res, await organizations.addMember(id, user.id, input), 201);
  });

  router.patch("/organizations/:id/members/:userId", async (req, res) => {
    const user = requireUser(req);
    const { id, userId } = parseInput(memberParamsSchema, req.params, "member");
    const { role } = parseInput(z.strictObject({ role: roleSchema }), req.body, "role");
    await organizations.changeRole(id, user.id, userId, role);
    res.status(204).end();
  });

  router.delete("/organizations/:id/members/:userId", async (req, res) => {
    const user = requireUser(req);
    const { id, userId } = parseInput(memberParamsSchema, req.params, "member");
    await organizations.removeMember(id, user.id, userId);
    res.status(204).end();
  });

  return router;
}
