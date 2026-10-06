"use client";

import { useState } from "react";

import { Button, ErrorNote, Label } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { safeHttpUrl } from "@/lib/format";
import type { PublicLinkInfo } from "@/lib/types";
import { useApi } from "@/lib/useApi";

/**
 * A free public HTTPS address for the project's live app, through a
 * Cloudflare quick tunnel: no domain, no DNS, nothing opened on the router.
 */
export function PublicLink({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const link = useApi<PublicLinkInfo>(`/projects/${projectId}/public-link`, {
    // While Cloudflare assigns the address, check every 2 seconds.
    pollMs: (info) => (info.enabled && info.state === "starting" ? 2_000 : null),
  });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await link.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  }

  const enable = (fresh: boolean) => {
    const question = fresh
      ? "Get a new public address? The current one stops working."
      : "Make this app public? Anyone with the link will be able to open it.";
    if (!window.confirm(question)) return;
    void act(() => api(`/projects/${projectId}/public-link`, { method: "POST" }));
  };

  const disable = () => {
    if (!window.confirm("Turn off the public link? The address stops working right away.")) return;
    void act(() => api(`/projects/${projectId}/public-link`, { method: "DELETE" }));
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const info = link.data;
  const href = info?.url ? safeHttpUrl(info.url) : null;

  return (
    <div className="glass-inset mt-5 rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label>Public link</Label>
          <span className="rounded-full border border-rivet px-2 py-0.5 text-[0.6875rem] text-ink-soft">Free · via Cloudflare</span>
        </div>
        {info?.enabled && canEdit && (
          <div className="flex items-center gap-3 text-sm">
            <button type="button" onClick={() => enable(true)} disabled={busy} className="text-ink-soft underline decoration-rivet underline-offset-4 hover:text-ink hover:decoration-ink">
              New address
            </button>
            <button type="button" onClick={disable} disabled={busy} className="text-ink underline decoration-rivet underline-offset-4 hover:decoration-ink">
              Turn off
            </button>
          </div>
        )}
      </div>

      {info && !info.available && (
        <p className="mt-3 text-sm text-ink-soft">Public links go through Traefik routing: set SHIPYARD_PUBLIC_DOMAIN and run npm run db:up.</p>
      )}

      {info?.available && !info.enabled && (
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <p className="max-w-xl text-sm text-ink-soft">
            Share the running app with anyone: a free HTTPS address on trycloudflare.com, no domain or router setup. Meant for sharing and
            testing; the address is random and changes if the tunnel restarts.
          </p>
          {canEdit ? (
            <Button busy={busy} onClick={() => enable(false)}>
              Create public link
            </Button>
          ) : (
            <span className="text-sm text-ink-soft">Off</span>
          )}
        </div>
      )}

      {info?.enabled && info.state === "live" && href && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 break-all rounded-xl border border-white/[0.12] bg-white/[0.06] px-3 py-2 font-mono text-sm text-ink hover:border-white/30"
          >
            <span aria-hidden className="mr-2 inline-block size-2 rounded-full bg-sea align-middle" />
            {href}
          </a>
          <Button variant="secondary" onClick={() => void copy(href)}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <p className="w-full text-xs text-ink-soft">A new address can take up to a minute to start answering everywhere.</p>
        </div>
      )}

      {info?.enabled && (info.state === "starting" || (info.state === "live" && !href)) && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
          <span aria-hidden className="signal-pulse size-2 rounded-full bg-signal" />
          Getting a public address from Cloudflare…
        </p>
      )}

      {info?.enabled && (info.state === "failed" || info.state === "absent") && (
        <div className="mt-3 flex flex-col gap-3">
          <ErrorNote title={info.state === "absent" ? "The public link isn't running" : "The public link stopped"}>
            {info.detail ?? "Start it again to get a new address."}
          </ErrorNote>
          {canEdit && (
            <div>
              <Button variant="secondary" busy={busy} onClick={() => enable(true)}>
                Start again
              </Button>
            </div>
          )}
        </div>
      )}

      {(error ?? link.error) && (
        <div className="mt-3">
          <ErrorNote title="Couldn't update the public link">{(error ?? link.error)!.message}</ErrorNote>
        </div>
      )}
    </div>
  );
}
