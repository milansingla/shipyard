"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "@/lib/api";
import { SessionContext } from "@/lib/session";
import type { User } from "@/lib/types";

import { ActivityIcon, AssistantIcon, BellIcon, HullMark, KeyIcon, PlusIcon, ProjectsIcon, SignOutIcon, TeamsIcon } from "./icons";
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
      <div className="min-h-dvh lg:p-4">
        <div className="app-frame relative mx-auto flex min-h-dvh max-w-[1520px] flex-col overflow-clip lg:min-h-[calc(100dvh-2rem)] lg:flex-row lg:gap-2 lg:rounded-[2.25rem] lg:border lg:border-white/[0.08] lg:p-4 lg:shadow-[0_40px_120px_-40px_rgb(0_0_0/0.9)]">
          <Sidebar />
          <div className="min-w-0 flex-1 px-4 pb-20 sm:px-6 lg:px-6">
            <Header user={state.user} onSignedOut={signedOut} />
            <main className="mx-auto w-full max-w-6xl">{children}</main>
          </div>
        </div>
      </div>
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
    <main className="app-frame relative flex min-h-dvh flex-col justify-center overflow-hidden px-4 sm:px-12">
      <Rings />
      <div className="relative mx-auto w-full max-w-6xl">
        <h1 className="-ml-1 text-[clamp(4.5rem,17vw,15rem)]">
          <Wordmark waterline />
        </h1>
        <div className="mt-10 grid gap-8 sm:grid-cols-[1fr_auto] sm:items-end">
          <p className="max-w-md text-lg leading-relaxed text-ink-soft">
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
    <main className="app-frame flex min-h-dvh flex-col justify-center px-4">
      <div className="panel mx-auto flex w-full max-w-2xl flex-col gap-8">
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
      </div>
    </main>
  );
}

/** Concentric rings behind the sign-in, like the yard's lights through haze. Decorative. */
function Rings() {
  return (
    <div aria-hidden className="pointer-events-none absolute right-[-12rem] top-1/2 size-[46rem] -translate-y-1/2 opacity-80">
      <div className="absolute inset-[30%] rounded-full bg-[radial-gradient(circle,rgb(255_122_47/0.55),rgb(255_122_47/0)_70%)] blur-2xl" />
      {[0, 12, 24, 36].map((inset) => (
        <div key={inset} className="absolute rounded-full border border-white/[0.07]" style={{ inset: `${inset}%` }} />
      ))}
    </div>
  );
}

const NAV = [
  { href: "/", label: "Projects", icon: ProjectsIcon },
  { href: "/projects/new", label: "New project", icon: PlusIcon },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
  { href: "/assistant", label: "Assistant", icon: AssistantIcon },
  { href: "/teams", label: "Organizations", icon: TeamsIcon },
] as const;

const NAV_BOTTOM = [
  { href: "/alerts", label: "Alerts", icon: BellIcon },
  { href: "/account", label: "API keys", icon: KeyIcon },
] as const;

/** Which section a path belongs to: a project's or deployment's pages count as Projects. */
function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/" || ((pathname.startsWith("/projects/") && pathname !== "/projects/new") || pathname.startsWith("/deployments/"));
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The icon rail: down the left on large screens, across the top on small ones. */
function Sidebar() {
  const pathname = usePathname();
  const item = ({ href, label, icon: ItemIcon }: (typeof NAV)[number] | (typeof NAV_BOTTOM)[number]) => {
    const active = isActive(href, pathname);
    return (
      <li key={href}>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={`group relative flex size-10 items-center justify-center rounded-xl transition-colors ${
            active ? "bg-white/[0.12] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]" : "text-ink-soft hover:bg-white/[0.06] hover:text-ink"
          }`}
        >
          <ItemIcon />
          {/* The label, beside the rail on hover or keyboard focus (large screens). */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-full z-20 ml-3 hidden whitespace-nowrap rounded-lg border border-white/10 bg-[#232326] px-2.5 py-1 text-xs font-semibold text-ink opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 lg:block"
          >
            {label}
          </span>
        </Link>
      </li>
    );
  };

  return (
    <nav
      aria-label="Main"
      className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.06] bg-[#121214]/90 px-3 py-2 backdrop-blur-xl lg:top-4 lg:h-[calc(100dvh-4rem)] lg:w-[4.5rem] lg:flex-col lg:rounded-[1.75rem] lg:border lg:border-white/[0.06] lg:bg-[#0f0f11]/85 lg:px-0 lg:py-5"
    >
      <Link href="/" aria-label="Shipyard: all projects" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-ink text-[#121214] lg:mb-6">
        <HullMark className="size-6" />
      </Link>
      <ul className="flex flex-1 flex-wrap items-center gap-1 lg:flex-none lg:flex-col lg:gap-2">{NAV.map(item)}</ul>
      <ul className="flex items-center gap-1 lg:mt-auto lg:flex-col lg:gap-2">{NAV_BOTTOM.map(item)}</ul>
    </nav>
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
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 py-5 lg:pt-3">
      <Link href="/" aria-label="Shipyard: all projects" className="text-2xl">
        <Wordmark />
      </Link>
      <div className="flex items-center gap-2 whitespace-nowrap">
        <span className="flex items-center gap-2.5 rounded-full border border-white/[0.08] bg-white/[0.04] py-1 pl-1 pr-3.5 text-sm">
          {user.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote avatar, no optimisation needed
            <img src={user.avatarUrl} alt="" width={32} height={32} className="size-8 rounded-full ring-2 ring-ember/60" />
          ) : (
            <span aria-hidden className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-ember to-signal text-sm font-bold text-[#121214]">
              {user.login.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="font-semibold">{user.login}</span>
        </span>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={busy}
          aria-busy={busy}
          aria-label="Sign out"
          title="Sign out"
          className="flex size-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
        >
          <SignOutIcon />
        </button>
      </div>
    </header>
  );
}
