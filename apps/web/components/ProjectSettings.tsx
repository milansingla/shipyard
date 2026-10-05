"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { Project } from "@/lib/types";

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

/** Turns an optional number field into the API's value: empty means "use the default" (null). */
function optionalInt(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

/** How a new deployment is judged healthy. Saved settings apply to the next deploy. */
export function ProjectSettings({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [path, setPath] = useState(project.healthCheckPath);
  const [port, setPort] = useState(project.healthCheckPort?.toString() ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(project.healthCheckTimeoutSeconds?.toString() ?? "");
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
          healthCheckPort: optionalInt(port),
          healthCheckTimeoutSeconds: optionalInt(timeoutSeconds),
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

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Button type="submit" busy={busy}>
            Save settings
          </Button>
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
