"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { duration, relativeTime } from "@/lib/format";
import type { CronJob, CronRun, CronRunStatus, Service } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

const RUN_LABEL: Record<CronRunStatus, string> = {
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  TIMED_OUT: "Timed out",
  SKIPPED: "Skipped",
};

const RUN_TONE: Record<CronRunStatus, string> = {
  RUNNING: "text-ink",
  SUCCEEDED: "text-sea",
  FAILED: "text-oxide",
  TIMED_OUT: "text-oxide",
  SKIPPED: "text-ink-soft",
};

/** "Oct 7, 03:00 UTC": schedules are in UTC, so times are shown in UTC too. */
function utc(iso: string): string {
  return `${new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
}

interface Draft {
  name: string;
  serviceId: string;
  schedule: string;
  command: string;
}

/** Commands run on a schedule in a service's live image, each run recorded. */
export function CronPanel({
  projectId,
  services,
  canEdit,
  canRun,
}: {
  projectId: string;
  services: Service[];
  canEdit: boolean;
  canRun: boolean;
}) {
  const runnable = services.filter((service) => service.type !== "POSTGRES");
  const jobs = useApi<CronJob[]>(`/projects/${projectId}/cron-jobs`, {
    pollMs: (list) => (list.some((job) => job.lastRun?.status === "RUNNING") ? 3000 : null),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await jobs.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(null);
    }
  }

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    void act("add", async () => {
      await api(`/projects/${projectId}/cron-jobs`, {
        method: "POST",
        body: { name: draft.name.trim(), serviceId: draft.serviceId, schedule: draft.schedule.trim(), command: draft.command.trim() },
      });
      setDraft(null);
    });
  };

  const list = jobs.data ?? [];

  return (
    <section className="mt-12" aria-labelledby="cron-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="cron-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
          Cron jobs
        </h2>
        <p className="text-sm text-ink-soft">Schedules are in UTC.</p>
      </div>

      {jobs.error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't load cron jobs">{jobs.error.message}</ErrorNote>
        </div>
      )}

      {jobs.data && list.length === 0 && !draft && (
        <p className="mt-4 text-ink-soft">
          No cron jobs. Run a command on a schedule, like a nightly cleanup, in one of your services&apos; images.
        </p>
      )}

      {list.length > 0 && (
        <ul className="mt-4 divide-y divide-rivet border-y border-rivet text-sm">
          {list.map((job) => (
            <li key={job.id} className="py-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-center">
                <div className="min-w-0">
                  <span className="font-semibold">{job.name}</span>
                  <Mono className="ml-2 text-xs text-ink-soft">{job.schedule}</Mono>
                  {job.managedBy === "CONFIG_FILE" && (
                    <span className="ml-2 rounded-sm border border-rivet px-1.5 py-0.5 text-xs text-ink-soft">shipyard.yaml</span>
                  )}
                  <p className="mt-1 truncate text-xs text-ink-soft">
                    in {job.serviceName}: <Mono>{job.command}</Mono>
                  </p>
                </div>
                <div className="text-xs">
                  {job.lastRun ? (
                    <p>
                      <span className={`font-semibold ${RUN_TONE[job.lastRun.status]}`}>{RUN_LABEL[job.lastRun.status]}</span>{" "}
                      <span className="text-ink-soft">{relativeTime(job.lastRun.startedAt)}</span>
                    </p>
                  ) : (
                    <p className="text-ink-soft">Never ran</p>
                  )}
                  <p className="mt-1 text-ink-soft">{job.enabled && job.nextRunAt ? `Next: ${utc(job.nextRunAt)}` : "Paused"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {canRun && (
                    <Button
                      variant="secondary"
                      busy={busy === `run:${job.id}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void act(`run:${job.id}`, async () => {
                          await api(`/cron-jobs/${job.id}/run`, { method: "POST" });
                          setOpen(job.id);
                        })
                      }
                    >
                      Run now
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpen(open === job.id ? null : job.id)}
                    aria-expanded={open === job.id}
                    className="text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink"
                  >
                    {open === job.id ? "Hide runs" : "Runs"}
                    <span className="sr-only"> of {job.name}</span>
                  </button>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(`toggle:${job.id}`, () => api(`/cron-jobs/${job.id}`, { method: "PATCH", body: { enabled: !job.enabled } }))
                        }
                        className="text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink"
                      >
                        {job.enabled ? "Pause" : "Resume"}
                        <span className="sr-only"> {job.name}</span>
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          if (window.confirm(`Delete the cron job ${job.name} and its run history?`)) {
                            void act(`delete:${job.id}`, () => api(`/cron-jobs/${job.id}`, { method: "DELETE" }));
                          }
                        }}
                        className="text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                      >
                        Delete<span className="sr-only"> {job.name}</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
              {open === job.id && <CronRuns jobId={job.id} />}
            </li>
          ))}
        </ul>
      )}

      {canEdit && !draft && runnable.length > 0 && (
        <div className="mt-4">
          <Button
            variant="secondary"
            onClick={() => setDraft({ name: "", serviceId: (runnable.find((s) => s.primary) ?? runnable[0]!).id, schedule: "0 3 * * *", command: "" })}
          >
            Add a cron job
          </Button>
        </div>
      )}

      {canEdit && draft && (
        <form onSubmit={add} className="mt-6 grid gap-4 border-t border-rivet pt-6 sm:grid-cols-3">
          <label className="flex flex-col gap-2">
            <Label>Name</Label>
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
              maxLength={30}
              placeholder="cleanup"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-2">
            <Label>Runs in</Label>
            <select value={draft.serviceId} onChange={(event) => setDraft({ ...draft, serviceId: event.target.value })} className={FIELD}>
              {runnable.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}&apos;s image and variables
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <Label>Schedule (UTC)</Label>
            <input
              value={draft.schedule}
              onChange={(event) => setDraft({ ...draft, schedule: event.target.value })}
              required
              maxLength={100}
              placeholder="0 3 * * *"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-2 sm:col-span-3">
            <Label>Command</Label>
            <input
              value={draft.command}
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              required
              maxLength={1000}
              placeholder="npm run cleanup"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </label>
          <p className="text-xs text-ink-soft sm:col-span-3">
            Five fields: minute, hour, day of month, month, day of week. <Mono>0 3 * * *</Mono> is every day at 03:00,{" "}
            <Mono>*/15 * * * *</Mono> every 15 minutes; <Mono>@daily</Mono> and <Mono>@hourly</Mono> work too. A run is skipped
            while the previous one is still going, and stopped after an hour.
          </p>
          <div className="flex gap-3 sm:col-span-3">
            <Button type="submit" busy={busy === "add"}>
              Add cron job
            </Button>
            <Button variant="secondary" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {error && (
        <div className="mt-4">
          <ErrorNote title="That didn't work">{error.message}</ErrorNote>
        </div>
      )}
    </section>
  );
}

/** A job's recent runs; picking one shows its output. */
function CronRuns({ jobId }: { jobId: string }) {
  const runs = useApi<CronRun[]>(`/cron-jobs/${jobId}/runs?limit=10`, {
    pollMs: (list) => (list.some((run) => run.status === "RUNNING") ? 2000 : null),
  });
  const [shown, setShown] = useState<string | null>(null);
  const output = useApi<CronRun>(shown ? `/cron-runs/${shown}` : null);

  if (runs.error) return <p className="mt-3 text-sm text-oxide">{runs.error.message}</p>;
  if (!runs.data) return null;
  if (runs.data.length === 0) return <p className="mt-3 text-sm text-ink-soft">No runs yet.</p>;

  return (
    <div className="mt-3 border-l-2 border-rivet pl-4">
      <ul className="space-y-1 text-xs">
        {runs.data.map((run) => (
          <li key={run.id} className="flex flex-wrap items-baseline gap-x-3">
            <button
              type="button"
              onClick={() => setShown(shown === run.id ? null : run.id)}
              aria-expanded={shown === run.id}
              className={`font-semibold underline decoration-rivet underline-offset-4 ${RUN_TONE[run.status]}`}
            >
              {RUN_LABEL[run.status]}
            </button>
            <span className="text-ink-soft">
              {relativeTime(run.startedAt)}
              {run.trigger === "MANUAL" && " · run by hand"}
              {run.finishedAt && run.status !== "SKIPPED" && ` · ${duration(run.startedAt, run.finishedAt)}`}
            </span>
            {run.errorMessage && <span className="text-ink-soft">{run.errorMessage}</span>}
          </li>
        ))}
      </ul>
      {shown && output.data?.id === shown && (
        <pre className="mt-3 max-h-72 overflow-auto bg-ink p-3 font-mono text-xs text-plate">
          {output.data.output || (output.data.status === "RUNNING" ? "Running… output appears when it finishes." : "No output.")}
        </pre>
      )}
    </div>
  );
}
