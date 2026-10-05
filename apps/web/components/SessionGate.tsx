"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "@/lib/api";
import { SessionContext } from "@/lib/session";
import type { User } from "@/lib/types";

import { Button, ErrorNote, Wordmark, buttonClass } from "./ui";

type GateState =
  | { kind: "loading" }
  | { kind: "signedIn"; user: User }
  | { kind: "signedOut" }
  | { kind: "problem"; error: ApiError };

const SIGN_IN_ERRORS: Record<string, string> = {
  FORBIDDEN:
    "That GitHub account isn't allowed to sign in here. Ask whoever runs this Shipyard to add your login to SHIPYARD_ALLOWED_GITHUB_USERS.",
  OAUTH_FAILED: "Sign-in didn't finish: it was cancelled, expired, or started in another browser. Try again.",
  GITHUB_ERROR: "Shipyard couldn't reach GitHub to finish signing in. Try again in a moment.",
};

/** Shows the app to signed-in users, and the sign-in screen (or what's misconfigured) to everyone else. */
export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "loading" });

  const check = useCallback(async () => {
    try {
      setState({ kind: "signedIn", user: await api<User>("/auth/me") });
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught));
      setState(error.isSignedOut ? { kind: "signedOut" } : { kind: "problem", error });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const signedOut = useCallback(() => setState({ kind: "signedOut" }), []);
  const session = useMemo(
    () => (state.kind === "signedIn" ? { user: state.user, signedOut } : null),
    [state, signedOut],
  );

  if (state.kind === "loading") return <div aria-busy className="min-h-dvh" />;
  if (state.kind === "signedOut") return <SignIn />;
  if (state.kind === "problem") return <Problem error={state.error} retry={check} />;

  return (
    <SessionContext.Provider value={session}>
      <Header user={state.user} onSignedOut={signedOut} />
      <main className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-8">{children}</main>
    </SessionContext.Provider>
  );
}

function SignIn() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Set by the API when a GitHub sign-in fails; removed so a reload doesn't repeat it.
    const params = new URLSearchParams(window.location.search);
    const code = params.get("signin_error");
    if (code) {
      setError(SIGN_IN_ERRORS[code] ?? `Sign-in failed (${code}). Try again.`);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  return (
    <main className="relative flex min-h-dvh flex-col justify-center overflow-hidden px-4 sm:px-12">
      <div className="relative mx-auto w-full max-w-6xl">
        <h1 className="-ml-1 text-[clamp(4.5rem,17vw,15rem)]">
          <Wordmark waterline />
        </h1>
        <div className="mt-10 grid gap-8 sm:grid-cols-[1fr_auto] sm:items-end">
          <p className="max-w-md text-lg text-ink-soft">
            Deploy your GitHub repositories to this machine. Pick a repository and a branch; Shipyard builds it,
            starts it, checks it answers, and gives you its URL.
          </p>
          <a href="/api/auth/github/login" className={`${buttonClass("primary")} h-12 px-6 text-base`}>
            Sign in with GitHub
          </a>
        </div>
        {error && (
          <div className="mt-8 max-w-xl">
            <ErrorNote title="You're not signed in">{error}</ErrorNote>
          </div>
        )}
      </div>
    </main>
  );
}

function Problem({ error, retry }: { error: ApiError; retry: () => void }) {
  const title = error.code === "AUTH_NOT_CONFIGURED" ? "GitHub sign-in isn't set up yet" : "Shipyard isn't reachable";
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-4">
      <Wordmark className="text-6xl" />
      <ErrorNote title={title}>
        <p>{error.message}</p>
        {error.code === "AUTH_NOT_CONFIGURED" && (
          <p className="mt-2">
            Setup steps are in <code className="font-mono">docs/github.md</code>. Restart the API after editing{" "}
            <code className="font-mono">.env</code>.
          </p>
        )}
      </ErrorNote>
      <div>
        <Button variant="secondary" onClick={retry}>
          Check again
        </Button>
      </div>
    </main>
  );
}

function Header({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      onSignedOut();
    }
  }

  return (
    <header className="border-b border-rivet">
      {/* Wraps onto a second row on narrow screens instead of scrolling sideways. */}
      <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-8">
        <Link href="/" aria-label="Shipyard: all projects" className="text-3xl">
          <Wordmark />
        </Link>
        <div className="flex flex-wrap items-center gap-3 whitespace-nowrap sm:gap-4">
          <span className="flex items-center gap-2 text-sm">
            {user.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- remote avatar, no optimisation needed
              <img src={user.avatarUrl} alt="" width={28} height={28} className="size-7 rounded-full" />
            )}
            <span className="hidden font-semibold sm:inline">{user.login}</span>
          </span>
          <Link href="/teams" className="text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink">
            Teams
          </Link>
          <Link href="/activity" className="text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink">
            Activity
          </Link>
          <Link href="/account" className="text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink">
            API keys
          </Link>
          <Button variant="secondary" busy={busy} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
