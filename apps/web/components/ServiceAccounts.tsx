"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { ApiKey, Organization, OrgRole, ServiceAccount } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

/** Automation identities (CI, scripts) of an organization: API keys only. Its admins manage them. */
export function ServiceAccounts({ organization }: { organization: Organization }) {
  const accounts = useApi<ServiceAccount[]>(`/organizations/${organization.id}/service-accounts`);
  const [draft, setDraft] = useState({ name: "", role: "DEVELOPER" as OrgRole });
  const [token, setToken] = useState<{ account: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await accounts.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  }

  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await api(`/organizations/${organization.id}/service-accounts`, { method: "POST", body: { name: draft.name.trim(), role: draft.role } });
      setDraft({ ...draft, name: "" });
    });
  };

  const newKey = (account: ServiceAccount, scope: string) =>
    void act(async () => {
      const result = await api<{ key: ApiKey; token: string }>(`/service-accounts/${account.id}/keys`, {
        method: "POST",
        body: { name: `${scope} key`, expiresInDays: 365, scopes: [scope] },
      });
      setToken({ account: account.login, value: result.token });
    });

  return (
    <section className="panel mt-6" aria-labelledby="service-accounts-heading">
      <h2 id="service-accounts-heading" className="section-title">
        Service accounts
      </h2>
      <p className="mt-1 text-sm text-ink-soft">For CI and scripts: a member with a fixed role that only uses API keys, never a sign-in.</p>
      {token && (
        <div className="mt-4 rounded-2xl border border-rivet bg-primer/70 px-4 py-3 text-sm" role="status">
          <p className="font-semibold">Key for {token.account}: copy it now, it won&apos;t be shown again.</p>
          <Mono className="mt-1 block break-all">{token.value}</Mono>
        </div>
      )}
      {accounts.data?.length === 0 && <p className="mt-3 text-sm text-ink-soft">None yet.</p>}
      <ul className="mt-4 divide-y divide-rivet border-y border-rivet text-sm">
        {(accounts.data ?? []).map((account) => (
          <li key={account.id} className="py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="font-semibold">{account.login}</span> <span className="text-ink-soft">{account.role.toLowerCase()}</span>
              </span>
              <span className="flex flex-wrap gap-3">
                <button type="button" disabled={busy} onClick={() => newKey(account, "deploy")} className="underline decoration-rivet underline-offset-4">
                  New deploy key<span className="sr-only"> for {account.login}</span>
                </button>
                <button type="button" disabled={busy} onClick={() => newKey(account, "read")} className="underline decoration-rivet underline-offset-4">
                  New read key<span className="sr-only"> for {account.login}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => window.confirm(`Delete ${account.login}? Its keys stop working at once.`) && void act(() => api(`/service-accounts/${account.id}`, { method: "DELETE" }))}
                  className="text-ink underline decoration-rivet underline-offset-4 hover:decoration-ink"
                >
                  Delete<span className="sr-only"> {account.login}</span>
                </button>
              </span>
            </div>
            {account.keys.filter((key) => !key.revokedAt).length > 0 && (
              <ul className="mt-1 text-xs text-ink-soft">
                {account.keys
                  .filter((key) => !key.revokedAt)
                  .map((key) => (
                    <li key={key.id} className="flex gap-3">
                      <Mono>{key.prefix}…</Mono> {key.scopes.join(", ") || "all"}
                      <button type="button" disabled={busy} onClick={() => void act(() => api(`/service-accounts/${account.id}/keys/${key.id}`, { method: "DELETE" }))} className="underline">
                        Revoke<span className="sr-only"> {key.prefix}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-2">
          <Label>Name</Label>
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={40} placeholder="ci" className={`${FIELD} font-mono`} />
        </label>
        <label className="flex flex-col gap-2">
          <Label>Role</Label>
          <select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as OrgRole })} className={FIELD}>
            <option value="VIEWER">viewer</option>
            <option value="DEVELOPER">developer</option>
            <option value="ADMIN">admin</option>
          </select>
        </label>
        <Button type="submit" busy={busy}>
          Add service account
        </Button>
      </form>
      {error && (
        <div className="mt-4">
          <ErrorNote title="That didn't work">{error.message}</ErrorNote>
        </div>
      )}
    </section>
  );
}
