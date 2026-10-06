"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { safeHttpUrl } from "@/lib/format";
import type { ProjectDomain } from "@/lib/types";
import { useApi } from "@/lib/useApi";

/** Custom hostnames for a project. They go live on the running deployment right away. */
export function DomainsPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const domains = useApi<ProjectDomain[]>(`/projects/${projectId}/domains`);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await domains.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  }

  const add = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await api(`/projects/${projectId}/domains`, { method: "POST", body: { hostname } });
      setHostname("");
    });
  };

  const remove = (domain: string) => {
    if (!window.confirm(`Remove ${domain}? It stops reaching this project right away.`)) return;
    void act(() => api(`/projects/${projectId}/domains/${encodeURIComponent(domain)}`, { method: "DELETE" }));
  };

  const list = domains.data ?? [];

  return (
    <section className="panel mt-6" aria-labelledby="domains-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="domains-heading" className="section-title">
          Domains
        </h2>
        <p className="text-sm text-ink-soft">Point each domain&apos;s DNS at this server.</p>
      </div>

      {list.length > 0 && (
        <ul className="mt-4 divide-y divide-rivet border-y border-rivet text-sm">
          {list.map((domain) => {
            const href = safeHttpUrl(domain.url);
            return (
              <li key={domain.hostname} className="flex items-center justify-between gap-4 py-3">
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer" className="min-w-0 break-all font-mono underline decoration-rivet underline-offset-4 hover:decoration-ink">
                    {domain.hostname}
                  </a>
                ) : (
                  <Mono>{domain.hostname}</Mono>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => remove(domain.hostname)}
                    disabled={busy}
                    className="text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                  >
                    Remove<span className="sr-only"> {domain.hostname}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!canEdit && list.length === 0 && <p className="mt-4 text-ink-soft">No custom domains.</p>}
      {canEdit && (
        <form onSubmit={add} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-2">
            <Label>Add a domain</Label>
            <input
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              required
              maxLength={253}
              placeholder="app.example.com"
              autoComplete="off"
              spellCheck={false}
              className="h-10 border border-rivet bg-plate px-3 font-mono text-sm focus:border-ink"
            />
          </label>
          <Button type="submit" busy={busy}>
            Add domain
          </Button>
        </form>
      )}

      {error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't update the domains">{error.message}</ErrorNote>
        </div>
      )}
    </section>
  );
}
