"use client";

import { createContext, useContext } from "react";

import type { User } from "./types";

export interface Session {
  user: User;
  /** Called when the API answers 401: the session expired or was revoked. */
  signedOut: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() must be used inside <SessionGate>.");
  return session;
}
