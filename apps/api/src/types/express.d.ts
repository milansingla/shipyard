import type { AuthUser } from "../modules/auth/AuthService.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware when the request has a valid session. */
      user?: AuthUser;
      /** How `user` was authenticated: a browser session cookie, or an API key. */
      authMethod?: "session" | "apiKey";
    }
  }
}

export {};
