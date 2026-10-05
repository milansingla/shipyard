import { type CookieOptions, Router } from "express";
import { z } from "zod";

import { readCookie } from "../../lib/cookies.js";
import { sendData } from "../../lib/http.js";
import { parseInput } from "../../lib/validation.js";
import { requireUser } from "../../middleware/authenticate.js";
import type { AuthService } from "./AuthService.js";

const LOGIN_COOKIE = "shipyard_oauth";
const LOGIN_COOKIE_PATH = "/api/auth/github";
const LOGIN_TTL_MS = 10 * 60 * 1000;

const callbackQuerySchema = z.object({
  code: z.string().max(512).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(512).optional(),
});

export interface AuthRouterOptions {
  sessionCookie: string;
  secureCookies: boolean;
  /** Where to send the browser after signing in. */
  appUrl: string;
}

export function createAuthRouter(auth: AuthService, options: AuthRouterOptions): Router {
  const router = Router();
  const base: CookieOptions = { httpOnly: true, secure: options.secureCookies, sameSite: "lax" };
  // Lax, not Strict: the callback is a top-level navigation FROM github.com,
  // and Strict cookies would not be sent with it.
  const loginCookie: CookieOptions = { ...base, path: LOGIN_COOKIE_PATH };
  const sessionCookie: CookieOptions = { ...base, path: "/" };

  router.get("/auth/github/login", (_req, res) => {
    const { authorizeUrl, loginCookie: value } = auth.startLogin();
    res.cookie(LOGIN_COOKIE, value, { ...loginCookie, maxAge: LOGIN_TTL_MS });
    res.redirect(302, authorizeUrl);
  });

  router.get("/auth/github/callback", async (req, res) => {
    const query = parseInput(callbackQuerySchema, req.query, "callback");
    // One attempt per login cookie, whatever the outcome.
    res.clearCookie(LOGIN_COOKIE, loginCookie);

    const { sessionToken, expiresAt } = await auth.completeLogin({
      ...query,
      loginCookie: readCookie(req.headers.cookie, LOGIN_COOKIE),
    });
    res.cookie(options.sessionCookie, sessionToken, { ...sessionCookie, expires: expiresAt });
    res.redirect(302, `${options.appUrl}/`);
  });

  router.get("/auth/me", (req, res) => {
    sendData(res, requireUser(req));
  });

  router.post("/auth/logout", async (req, res) => {
    await auth.logout(readCookie(req.headers.cookie, options.sessionCookie));
    res.clearCookie(options.sessionCookie, sessionCookie);
    res.status(204).end();
  });

  return router;
}
