"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { EnvironmentTarget, EnvironmentVariable, Service, VariableEnvironment } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const TARGET_LABEL: Record<EnvironmentTarget, string> = {
  RUNTIME: "Runtime",
  BUILD: "Build",
  BOTH: "Build + runtime",
};

const ENVIRONMENT_LABEL: Record<VariableEnvironment, string> = {
  ALL: "All",
  PRODUCTION: "Production",
  PREVIEW: "Previews",
  DEVELOPMENT: "Development",
};

/** `?service=<id>` for a service's own variable, `environment=` for one environment's; nothing for project-wide, all. */
function scopeQuery(serviceId: string, environment: VariableEnvironment): string {
  const params = new URLSearchParams();
  if (serviceId) params.set("service", serviceId);
  if (environment !== "ALL") params.set("environment", environment);
  const query = params.toString();
  return query ? `?${query}` : "";
}

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink disabled:opacity-60";

interface Draft {
  /** "" = every service. */
  serviceId: string;
  environment: VariableEnvironment;
  key: string;
  value: string;
  secret: boolean;
  target: EnvironmentTarget;
  /** Editing an existing variable: its name can't change. */
  existing: boolean;
}

const EMPTY: Draft = { serviceId: "", environment: "ALL", key: "", value: "", secret: false, target: "RUNTIME", existing: false };

/** A project's environment variables and secrets. Values apply on the next deploy. */
export function EnvironmentPanel({
  projectId,
  services,
  canEdit,
}: {
  projectId: string;
  services: Service[];
  canEdit: boolean;
}) {
  const serviceName = new Map(services.map((service) => [service.id, service.name]));
  const scoped = services.length > 1;
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
      await api(`/projects/${projectId}/env/${encodeURIComponent(draft.key.trim())}${scopeQuery(draft.serviceId, draft.environment)}`, {
        method: "PUT",
        body: { value: draft.value, secret: draft.secret, target: draft.secret ? "RUNTIME" : draft.target },
      });
      setDraft(EMPTY);
    });
  };

  const remove = (variable: EnvironmentVariable) => {
    if (!window.confirm(`Delete ${variable.key}? Deployments already running keep it until the next deploy.`)) return;
    void act(async () => {
      await api(`/projects/${projectId}/env/${encodeURIComponent(variable.key)}${scopeQuery(variable.serviceId ?? "", variable.environment)}`, {
        method: "DELETE",
      });
      if (draft.key === variable.key) setDraft(EMPTY);
    });
  };

  const edit = (variable: EnvironmentVariable) => {
    setError(null);
    setDraft({
      serviceId: variable.serviceId ?? "",
      environment: variable.environment,
      key: variable.key,
      value: variable.value ?? "", // a secret's value is never sent back: type a new one
      secret: variable.secret,
      target: variable.target,
      existing: true,
    });
  };

  const list = variables.data ?? [];

  return (
    <section className="panel mt-6" aria-labelledby="environment-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="environment-heading" className="section-title">
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
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="border-b border-rivet">
              <tr>
                {["Name", ...(scoped ? ["For"] : []), "Environments", "Value", "Available at", ""].map((h) => (
                  <th key={h || "actions"} scope="col" className="py-2 pr-4 font-normal">
                    {h && <Label>{h}</Label>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-rivet">
              {list.map((variable) => (
                <tr key={`${variable.serviceId ?? "*"}:${variable.environment}:${variable.key}`}>
                  <td className="py-3 pr-4">
                    <Mono className="font-semibold">{variable.key}</Mono>
                  </td>
                  {scoped && (
                    <td className="py-3 pr-4 text-ink-soft">
                      {variable.serviceId ? serviceName.get(variable.serviceId) ?? "—" : "All services"}
                    </td>
                  )}
                  <td className="py-3 pr-4 text-ink-soft">
                    {ENVIRONMENT_LABEL[variable.environment]}
                    {variable.environment === "ALL" && variable.secret && (
                      <span className="block text-xs" title="A preview runs a pull request's code: it only gets secrets set for Previews.">
                        not previews
                      </span>
                    )}
                  </td>
                  <td className="max-w-[22rem] py-3 pr-4">
                    {variable.value === null && !variable.secret ? (
                      <span className="text-xs text-ink-soft">hidden for your role</span>
                    ) : variable.secret ? (
                      <span className="text-ink-soft">
                        <Mono aria-hidden>••••••••</Mono> <span className="text-xs">secret, hidden</span>
                      </span>
                    ) : (
                      <Mono className="block truncate">{variable.value}</Mono>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-ink-soft">{TARGET_LABEL[variable.target]}</td>
                  <td className="py-3 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => edit(variable)}
                          className="text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink"
                        >
                          Edit<span className="sr-only"> {variable.key}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(variable)}
                          disabled={busy}
                          className="ml-4 text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                        >
                          Delete<span className="sr-only"> {variable.key}</span>
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <form onSubmit={save} className="mt-6 grid gap-4 border-t border-rivet pt-6 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,11rem)]">
          {scoped && (
            <label className="flex flex-col gap-2 sm:col-span-3">
              <Label>For</Label>
              <select
                value={draft.serviceId}
                onChange={(event) => setDraft({ ...draft, serviceId: event.target.value })}
                disabled={draft.existing}
                className={FIELD}
              >
                <option value="">All services</option>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    Only {service.name} (overrides the shared value)
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-2 sm:col-span-3">
            <Label>Environments</Label>
            <select
              value={draft.environment}
              onChange={(event) => setDraft({ ...draft, environment: event.target.value as VariableEnvironment })}
              disabled={draft.existing}
              className={FIELD}
            >
              <option value="ALL">All (a secret: all but previews)</option>
              <option value="PRODUCTION">Production only</option>
              <option value="PREVIEW">Previews only (overrides the shared value)</option>
              <option value="DEVELOPMENT">Development only (overrides the shared value)</option>
            </select>
          </label>
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
      )}

      {error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't update the environment">{error.message}</ErrorNote>
        </div>
      )}
    </section>
  );
}
