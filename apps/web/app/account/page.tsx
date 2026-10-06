"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { ApiKey } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const EXPIRY: Array<{ label: string; days: number | null }> = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never", days: null },
];

/** API keys for the Shipyard CLI and scripts. A new key's token is shown exactly once. */
export default function AccountPage() {
  const keys = useApi<ApiKey[]>("/api-keys");
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [scope, setScope] = useState("all");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await keys.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  }

  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const result = await api<{ key: ApiKey; token: string }>("/api-keys", {
        method: "POST",
        body: { name, ...(expiry !== "never" && { expiresInDays: Number(expiry) }), ...(scope !== "all" && { scopes: [scope] }) },
      });
      setCreated({ name: result.key.name, token: result.token });
      setCopied(false);
      setName("");
    });
  };

  const revoke = (key: ApiKey) => {
    if (!window.confirm(`Revoke "${key.name}"? Anything using it stops working immediately.`)) return;
    void act(() => api(`/api-keys/${key.id}`, { method: "DELETE" }));
  };

  return (
    <div className="pt-2">
      <h1 className="page-title">API keys</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        For the Shipyard CLI and your scripts: <Mono>shipyard login</Mono>, or send{" "}
        <Mono>Authorization: Bearer &lt;key&gt;</Mono>. A key can do everything you can, so keep it secret.
      </p>

      {created && (
        <div role="status" className="mt-8 border-l-4 border-sea bg-sea-wash px-4 py-4">
          <p className="font-semibold">Copy the key for “{created.name}” now. It won&apos;t be shown again.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <code className="break-all bg-plate px-3 py-2 font-mono text-sm">{created.token}</code>
            <Button
              variant="secondary"
              onClick={() => void navigator.clipboard.writeText(created.token).then(() => setCopied(true))}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={create} className="panel mt-6 flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-2">
          <Label>Name</Label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={64}
            placeholder="e.g. laptop CLI"
            className="h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink"
          />
        </label>
        <label className="flex flex-col gap-2">
          <Label>Expires after</Label>
          <select
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            className="h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink"
          >
            {EXPIRY.map((option) => (
              <option key={option.label} value={option.days ?? "never"}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2">
          <Label>May</Label>
          <select value={scope} onChange={(event) => setScope(event.target.value)} className="h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink">
            <option value="all">Do anything you can</option>
            <option value="deploy">Read and deploy</option>
            <option value="read">Only read</option>
          </select>
        </label>
        <Button type="submit" busy={busy}>
          Create key
        </Button>
      </form>

      {error && (
        <div className="mt-4">
          <ErrorNote title="That didn't work">{error.message}</ErrorNote>
        </div>
      )}

      {keys.data && keys.data.length > 0 && (
        <div className="panel relative mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="border-b border-rivet">
              <tr>
                {["Name", "Key", "Last used", "Expires", ""].map((h) => (
                  <th key={h || "actions"} scope="col" className="py-2 pr-4 font-normal">
                    {h && <Label>{h}</Label>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-rivet">
              {keys.data.map((key) => (
                <tr key={key.id} className={key.revokedAt ? "text-ink-soft" : undefined}>
                  <td className="py-3 pr-4 font-semibold">{key.name}</td>
                  <td className="py-3 pr-4">
                    <Mono>{key.prefix}…</Mono>
                  </td>
                  <td className="py-3 pr-4">{key.lastUsedAt ? relativeTime(key.lastUsedAt) : "Never"}</td>
                  <td className="py-3 pr-4">
                    {key.revokedAt ? "Revoked" : key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "Never"}
                  </td>
                  <td className="py-3 text-right">
                    {!key.revokedAt && (
                      <button
                        type="button"
                        onClick={() => revoke(key)}
                        className="text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                      >
                        Revoke<span className="sr-only"> {key.name}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
