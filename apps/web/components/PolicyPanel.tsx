"use client";

import { type FormEvent, useEffect, useState } from "react";

import { Button, ErrorNote, Label } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { can } from "@/lib/roles";
import type { Organization, Policy } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink disabled:opacity-60";

const optional = (text: string) => (text.trim() === "" ? null : Number(text));

/** Rules for every project of the organization, checked before each deploy. */
export function PolicyPanel({ organization }: { organization: Organization }) {
  const policy = useApi<Policy>(`/organizations/${organization.id}/policy`);
  const admin = can(organization.role, "ADMIN");
  const [draft, setDraft] = useState({ memory: "", cpu: "", replicas: "", health: false, domains: "", approval: false });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const p = policy.data;
    if (!p) return;
    setDraft({
      memory: p.maxMemoryMb?.toString() ?? "",
      cpu: p.maxCpu?.toString() ?? "",
      replicas: p.maxReplicas?.toString() ?? "",
      health: p.requireHealthCheckPath,
      domains: p.allowedDomainSuffixes.map((s) => s.replace(/^\./, "")).join(", "),
      approval: p.requireApproval,
    });
  }, [policy.data]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await api(`/organizations/${organization.id}/policy`, {
        method: "PATCH",
        body: {
          maxMemoryMb: optional(draft.memory),
          maxCpu: optional(draft.cpu),
          maxReplicas: optional(draft.replicas),
          requireHealthCheckPath: draft.health,
          allowedDomainSuffixes: draft.domains.split(",").map((s) => s.trim()).filter(Boolean),
          requireApproval: draft.approval,
        },
      });
      setSaved(true);
      await policy.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-12" aria-labelledby="policy-heading">
      <h2 id="policy-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
        Policy
      </h2>
      <p className="mt-1 text-sm text-ink-soft">Checked before every deploy of this organization&apos;s projects. Empty = no rule.</p>
      <form onSubmit={(event) => void save(event)} className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-2">
          <Label>Max memory per service (MB)</Label>
          <input type="number" min={64} value={draft.memory} onChange={(e) => setDraft({ ...draft, memory: e.target.value })} disabled={!admin} placeholder="No rule" className={FIELD} />
        </label>
        <label className="flex flex-col gap-2">
          <Label>Max CPU per service</Label>
          <input type="number" min={0.1} step={0.1} value={draft.cpu} onChange={(e) => setDraft({ ...draft, cpu: e.target.value })} disabled={!admin} placeholder="No rule" className={FIELD} />
        </label>
        <label className="flex flex-col gap-2">
          <Label>Max replicas</Label>
          <input type="number" min={1} max={10} value={draft.replicas} onChange={(e) => setDraft({ ...draft, replicas: e.target.value })} disabled={!admin} placeholder="No rule" className={FIELD} />
        </label>
        <label className="flex flex-col gap-2 sm:col-span-3">
          <Label>Allowed custom domains</Label>
          <input value={draft.domains} onChange={(e) => setDraft({ ...draft, domains: e.target.value })} disabled={!admin} placeholder="Any; or e.g. example.com, example.org" className={FIELD} />
        </label>
        <label className="flex items-start gap-3 text-sm sm:col-span-3">
          <input type="checkbox" checked={draft.health} onChange={(e) => setDraft({ ...draft, health: e.target.checked })} disabled={!admin} className="mt-0.5 size-4 accent-ink" />
          <span>Web services must have a health check path (not &quot;/&quot;)</span>
        </label>
        <label className="flex items-start gap-3 text-sm sm:col-span-3">
          <input type="checkbox" checked={draft.approval} onChange={(e) => setDraft({ ...draft, approval: e.target.checked })} disabled={!admin} className="mt-0.5 size-4 accent-ink" />
          <span>
            <span className="font-semibold">Production deploys need an admin&apos;s approval</span>
            <span className="block text-ink-soft">Unless an admin deploys. Pushes wait too; previews and development never do.</span>
          </span>
        </label>
        {admin && (
          <div className="flex items-center gap-4 sm:col-span-3">
            <Button type="submit" busy={busy}>
              Save policy
            </Button>
            {saved && <span className="text-sm text-sea">Saved.</span>}
          </div>
        )}
      </form>
      {error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't save the policy">{error.message}</ErrorNote>
        </div>
      )}
    </section>
  );
}
