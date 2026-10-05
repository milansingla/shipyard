"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { EnvironmentTarget, EnvironmentVariable } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const TARGET_LABEL: Record<EnvironmentTarget, string> = {
  RUNTIME: "Runtime",
  BUILD: "Build",
  BOTH: "Build + runtime",
};

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink disabled:opacity-60";

interface Draft {
  key: string;
  value: string;
  secret: boolean;
  target: EnvironmentTarget;
  /** Editing an existing variable: its name can't change. */
  existing: boolean;
}

const EMPTY: Draft = { key: "", value: "", secret: false, target: "RUNTIME", existing: false };

/** A project's environment variables and secrets. Values apply on the next deploy. */
export function EnvironmentPanel({ projectId }: { projectId: string }) {
  const variables = useApi<EnvironmentVariable[]>(`/projects/${projectId}/env`);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await variables.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await api(`/projects/${projectId}/env/${encodeURIComponent(draft.key.trim())}`, {
        method: "PUT",
        body: { value: draft.value, secret: draft.secret, target: draft.secret ? "RUNTIME" : draft.target },
      });
      setDraft(EMPTY);
    });
  };

  const remove = (key: string) => {
    if (!window.confirm(`Delete ${key}? Deployments already running keep it until the next deploy.`)) return;
    void act(async () => {
      await api(`/projects/${projectId}/env/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (draft.key === key) setDraft(EMPTY);
    });
  };

  const edit = (variable: EnvironmentVariable) => {
    setError(null);
    setDraft({
      key: variable.key,
      value: variable.value ?? "", // a secret's value is never sent back: type a new one
      secret: variable.secret,
      target: variable.target,
      existing: true,
    });
  };

  const list = variables.data ?? [];

  return (
    <section className="mt-12" aria-labelledby="environment-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="environment-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
          Environment
        </h2>
        <p className="text-sm text-ink-soft">Changes apply on the next deploy.</p>
      </div>

      {variables.error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't load variables">{variables.error.message}</ErrorNote>
        </div>
      )}

      {variables.data && list.length === 0 && (
        <p className="mt-4 text-ink-soft">
          No variables yet. Add the settings your app reads from its environment, such as a database URL or an API key.
        </p>
      )}

      {list.length > 0 && (
        // relative: keeps the buttons' screen-reader labels (absolutely positioned) inside the scroll box.
        <div className="relative mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="border-b border-rivet">
              <tr>
                {["Name", "Value", "Available at", ""].map((h) => (
                  <th key={h || "actions"} scope="col" className="py-2 pr-4 font-normal">
                    {h && <Label>{h}</Label>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-rivet">
              {list.map((variable) => (
                <tr key={variable.key}>
                  <td className="py-3 pr-4">
                    <Mono className="font-semibold">{variable.key}</Mono>
                  </td>
                  <td className="max-w-[22rem] py-3 pr-4">
                    {variable.secret ? (
                      <span className="text-ink-soft">
                        <Mono aria-hidden>••••••••</Mono> <span className="text-xs">secret, hidden</span>
                      </span>
                    ) : (
                      <Mono className="block truncate">{variable.value}</Mono>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-ink-soft">{TARGET_LABEL[variable.target]}</td>
                  <td className="py-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => edit(variable)}
                      className="text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink"
                    >
                      Edit<span className="sr-only"> {variable.key}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(variable.key)}
                      disabled={busy}
                      className="ml-4 text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                    >
                      Delete<span className="sr-only"> {variable.key}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={save} className="mt-6 grid gap-4 border-t border-rivet pt-6 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,11rem)]">
        <label className="flex flex-col gap-2">
          <Label>Name</Label>
          <input
            value={draft.key}
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
            readOnly={draft.existing}
            required
            maxLength={128}
            placeholder="e.g. REDIS_URL"
            autoComplete="off"
            spellCheck={false}
            className={`${FIELD} font-mono read-only:bg-primer`}
          />
        </label>
        <label className="flex flex-col gap-2">
          <Label>Value</Label>
          <input
            type={draft.secret ? "password" : "text"}
            value={draft.value}
            onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            placeholder={draft.existing && draft.secret ? "Type a new value to replace the secret" : ""}
            required={draft.secret}
            autoComplete="off"
            spellCheck={false}
            className={`${FIELD} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-2">
          <Label>Available at</Label>
          <select
            value={draft.secret ? "RUNTIME" : draft.target}
            onChange={(event) => setDraft({ ...draft, target: event.target.value as EnvironmentTarget })}
            disabled={draft.secret}
            className={FIELD}
          >
            {(Object.keys(TARGET_LABEL) as EnvironmentTarget[]).map((target) => (
              <option key={target} value={target}>
                {TARGET_LABEL[target]}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center justify-between gap-4 sm:col-span-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={draft.secret}
              onChange={(event) => setDraft({ ...draft, secret: event.target.checked })}
              className="mt-0.5 size-4 accent-ink"
            />
            <span>
              <span className="font-semibold">Secret</span>
              <span className="block text-ink-soft">
                Hidden after saving and only given to the running app, never to the build.
              </span>
            </span>
          </label>
          <div className="flex gap-3">
            {draft.existing && (
              <Button variant="secondary" onClick={() => setDraft(EMPTY)} disabled={busy}>
                Cancel
              </Button>
            )}
            <Button type="submit" busy={busy}>
              {draft.existing ? `Save ${draft.key}` : "Add variable"}
            </Button>
          </div>
        </div>
      </form>

      {error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't update the environment">{error.message}</ErrorNote>
        </div>
      )}
    </section>
  );
}
