import type { Request, RequestHandler } from "express";

import { readCookie } from "../lib/cookies.js";
import { AppError, ErrorCode, UnauthenticatedError } from "../lib/errors.js";
import type { AuthService, AuthUser } from "../modules/auth/AuthService.js";

/** `__Host-` makes browsers enforce Secure, Path=/ and no Domain — only possible over HTTPS. */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-shipyard_session" : "shipyard_session";
}

/** Attaches `req.user` when the session cookie is valid. Never rejects: routes decide. */
export function authenticate(auth: Pick<AuthService, "authenticate">, cookieName: string): RequestHandler {
  return async (req, _res, next) => {
    const user = await auth.authenticate(readCookie(req.headers.cookie, cookieName));
    if (user) req.user = user;
    next();
  };
}

/**
 * The signed-in user, or a 401. Every protected route calls this; services then
 * scope their queries to the user's id, so authorization is enforced twice.
 */
export function requireUser(req: Request): AuthUser {
  if (req.user) return req.user;
  if (req.app.locals.authConfigured !== true) {
    throw new AppError(
      ErrorCode.AUTH_NOT_CONFIGURED,
      "GitHub sign-in is not configured on this server. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and " +
        "SHIPYARD_SECRET_KEY (see .env.example).",
      { statusCode: 503 },
    );
  }
  throw new UnauthenticatedError();
}
