"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { Project, RestartPolicy } from "@/lib/types";

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

/** Turns an optional number field into the API's value: empty means "use the default" (null). */
function optionalNumber(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

const RESTART_LABEL: Record<RestartPolicy, string> = {
  UNLESS_STOPPED: "Always, until stopped",
  ON_FAILURE: "After a crash (up to 5 times)",
  NO: "Never",
};

/** How a new deployment is checked and what it may use. Saved settings apply to the next deploy. */
export function ProjectSettings({ project, canEdit, onSaved }: { project: Project; canEdit: boolean; onSaved: () => void }) {
  const [path, setPath] = useState(project.healthCheckPath);
  const [port, setPort] = useState(project.healthCheckPort?.toString() ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(project.healthCheckTimeoutSeconds?.toString() ?? "");
  const [cpu, setCpu] = useState(project.cpuLimit?.toString() ?? "");
  const [memory, setMemory] = useState(project.memoryLimitMb?.toString() ?? "");
  const [restartPolicy, setRestartPolicy] = useState<RestartPolicy>(project.restartPolicy);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await api(`/projects/${project.id}`, {
        method: "PATCH",
        body: {
          healthCheckPath: path.trim() || "/",
          healthCheckPort: optionalNumber(port),
          healthCheckTimeoutSeconds: optionalNumber(timeoutSeconds),
          cpuLimit: optionalNumber(cpu),
          memoryLimitMb: optionalNumber(memory),
          restartPolicy,
        },
      });
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-12" aria-labelledby="settings-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="settings-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
          Settings
        </h2>
        <p className="text-sm text-ink-soft">Changes apply on the next deploy.</p>
      </div>

      <form onSubmit={(event) => void save(event)} className="mt-4 border-t border-rivet pt-6">
        <fieldset disabled={!canEdit} className="disabled:opacity-80">
        <h3 className="font-semibold">Health check</h3>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          A new deployment only gets traffic once this check passes. On <code className="font-mono">/</code>, any answer
          below 500 counts; any other path must answer with a 2xx or 3xx status.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_minmax(0,10rem)]">
          <label className="flex flex-col gap-2">
            <Label>Path</Label>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/"
              maxLength={512}
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-2">
            <Label>Port</Label>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="App's port"
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-2">
            <Label>Timeout (s)</Label>
            <input
              type="number"
              inputMode="numeric"
              min={5}
              max={900}
              value={timeoutSeconds}
              onChange={(event) => setTimeoutSeconds(event.target.value)}
              placeholder="Default"
              className={FIELD}
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-ink-soft">
          Port: leave empty to check the app&apos;s own port. Timeout: how long a new deployment has to become healthy.
        </p>

        <h3 className="mt-8 font-semibold">Resources</h3>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Limits keep one app from starving the others on this server. An app that goes over its memory limit is stopped,
          and the deployment says so.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,10rem)_minmax(0,1fr)]">
          <label className="flex flex-col gap-2">
            <Label>CPU</Label>
            <input
              type="number"
              inputMode="decimal"
              min={0.1}
              max={64}
              step={0.01}
              value={cpu}
              onChange={(event) => setCpu(event.target.value)}
              placeholder="No limit"
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-2">
            <Label>Memory (MB)</Label>
            <input
              type="number"
              inputMode="numeric"
              min={64}
              value={memory}
              onChange={(event) => setMemory(event.target.value)}
              placeholder="No limit"
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-2">
            <Label>Restart the app</Label>
            <select
              value={restartPolicy}
              onChange={(event) => setRestartPolicy(event.target.value as RestartPolicy)}
              className={FIELD}
            >
              {(Object.keys(RESTART_LABEL) as RestartPolicy[]).map((policy) => (
                <option key={policy} value={policy}>
                  {RESTART_LABEL[policy]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-ink-soft">CPU: number of cores, e.g. 0.5 for half a core. Leave either empty for no limit.</p>

        </fieldset>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {canEdit ? (
            <Button type="submit" busy={busy}>
              Save settings
            </Button>
          ) : (
            <p className="text-sm text-ink-soft">Changing settings needs the ADMIN role.</p>
          )}
          {saved && (
            <span role="status" className="text-sm text-sea">
              Saved. The next deploy uses these settings.
            </span>
          )}
        </div>
      </form>

      {error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't save the settings">{error.message}</ErrorNote>
        </div>
      )}
    </section>
  );
}
