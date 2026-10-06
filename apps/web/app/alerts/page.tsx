"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { IncidentSummaryButton } from "@/components/Assistant";
import { relativeTime } from "@/lib/format";
import { can } from "@/lib/roles";
import type { AlertItem, NotificationChannel, Organization } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const KIND_LABEL: Record<AlertItem["kind"], string> = {
  DEPLOYMENT_FAILED: "Deploy failed",
  APP_DOWN: "App down",
  WORKER_OFFLINE: "Worker offline",
  HIGH_CPU: "High CPU",
  HIGH_MEMORY: "High memory",
  DISK_PRESSURE: "Disk full soon",
};

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

/** What is wrong right now (and what was), and where alerts are sent. */
export default function AlertsPage() {
  const [showResolved, setShowResolved] = useState(false);
  const alerts = useApi<AlertItem[]>(`/alerts?limit=100${showResolved ? "" : "&status=OPEN"}`, { pollMs: () => 30_000 });
  const organizations = useApi<Organization[]>("/organizations");
  const managed = (organizations.data ?? []).filter((org) => can(org.role, "ADMIN"));

  return (
    <div className="pt-2">
      <h1 className="page-title">Alerts</h1>
      <p className="mt-3 text-ink-soft">
        Failed deploys, apps that stopped, CPU or memory near their limit, and workers in trouble. Each problem is one alert; it
        resolves itself when the problem clears.
      </p>

      <div className="mt-8 flex items-center justify-between gap-4">
        <h2 className="section-title">{showResolved ? "All alerts" : "Open"}</h2>
        <button
          type="button"
          onClick={() => setShowResolved(!showResolved)}
          className="text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink"
        >
          {showResolved ? "Only open ones" : "Include resolved"}
        </button>
      </div>
      {alerts.error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't load alerts">{alerts.error.message}</ErrorNote>
        </div>
      )}
      {alerts.data?.length === 0 && <p className="mt-4 text-ink-soft">{showResolved ? "No alerts yet." : "Nothing is wrong right now."}</p>}
      {alerts.data && alerts.data.length > 0 && (
        <ul className="panel mt-4 divide-y divide-rivet text-sm">
          {alerts.data.map((alert) => (
            <li key={alert.id} className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_9rem]">
              <span
                className={`self-start justify-self-start rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${
                  alert.status === "RESOLVED" ? "bg-primer text-ink-soft" : alert.severity === "CRITICAL" ? "bg-oxide text-plate" : "bg-oxide-wash text-oxide"
                }`}
              >
                {alert.status === "RESOLVED" ? "Resolved" : KIND_LABEL[alert.kind]}
              </span>
              <div className="min-w-0">
                <p className="font-semibold">
                  {alert.projectId ? (
                    <Link href={`/projects/${alert.projectId}`} className="underline decoration-rivet underline-offset-4 hover:decoration-ink">
                      {alert.title}
                    </Link>
                  ) : (
                    alert.title
                  )}
                </p>
                <p className="mt-0.5 text-ink-soft">{alert.message}</p>
                {alert.projectId && <IncidentSummaryButton alertId={alert.id} />}
              </div>
              <time dateTime={alert.openedAt} className="text-ink-soft sm:text-right" title={new Date(alert.openedAt).toLocaleString()}>
                {relativeTime(alert.openedAt)}
                {alert.resolvedAt && <span className="block text-xs">resolved {relativeTime(alert.resolvedAt)}</span>}
              </time>
            </li>
          ))}
        </ul>
      )}

      {managed.map((org) => (
        <Channels key={org.id} organization={org} />
      ))}
    </div>
  );
}

/** An organization's notification channels (its admins). */
function Channels({ organization }: { organization: Organization }) {
  const channels = useApi<NotificationChannel[]>(`/organizations/${organization.id}/notification-channels`);
  const [draft, setDraft] = useState<{ name: string; type: NotificationChannel["type"]; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await channels.reload();
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
      await api(`/organizations/${organization.id}/notification-channels`, { method: "POST", body: { ...draft, url: draft.url.trim() } });
      setDraft(null);
    });
  };

  return (
    <section className="panel mt-6" aria-labelledby={`channels-${organization.id}`}>
      <h2 id={`channels-${organization.id}`} className="section-title">
        Where {organization.personal ? "your" : `${organization.name}'s`} alerts go
      </h2>
      {channels.data?.length === 0 && !draft && <p className="mt-3 text-ink-soft">Nowhere yet: alerts only show here.</p>}
      {channels.data && channels.data.length > 0 && (
        <ul className="mt-4 divide-y divide-rivet border-y border-rivet text-sm">
          {channels.data.map((channel) => (
            <li key={channel.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <span className="font-semibold">{channel.name}</span>{" "}
                <span className="text-ink-soft">
                  {channel.type === "SLACK" ? "Slack" : "Webhook"} · <Mono>{channel.host}</Mono>
                </span>
                {channel.lastError && <p className="mt-0.5 text-xs text-oxide">Last delivery failed: {channel.lastError}</p>}
              </div>
              <div className="flex items-center gap-4">
                <Button variant="secondary" busy={busy === `test:${channel.id}`} disabled={busy !== null} onClick={() => void act(`test:${channel.id}`, () => api(`/notification-channels/${channel.id}/test`, { method: "POST" }))}>
                  Send a test
                </Button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`Stop sending alerts to ${channel.name}?`)) {
                      void act(`delete:${channel.id}`, () => api(`/notification-channels/${channel.id}`, { method: "DELETE" }));
                    }
                  }}
                  className="text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                >
                  Remove<span className="sr-only"> {channel.name}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!draft && (
        <div className="mt-4">
          <Button variant="secondary" onClick={() => setDraft({ name: "", type: "SLACK", url: "" })}>
            Add a channel
          </Button>
        </div>
      )}
      {draft && (
        <form onSubmit={add} className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,10rem)_minmax(0,1fr)]">
          <label className="flex flex-col gap-2">
            <Label>Name</Label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={60} placeholder="#ops" className={FIELD} />
          </label>
          <label className="flex flex-col gap-2">
            <Label>Kind</Label>
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as NotificationChannel["type"] })} className={FIELD}>
              <option value="SLACK">Slack webhook</option>
              <option value="WEBHOOK">Webhook (JSON)</option>
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <Label>URL</Label>
            <input
              type="url"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              required
              placeholder="https://hooks.slack.com/services/…"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </label>
          <p className="text-xs text-ink-soft sm:col-span-3">
            Stored encrypted and never shown again; only its host is. It must be a public https address.
          </p>
          <div className="flex gap-3 sm:col-span-3">
            <Button type="submit" busy={busy === "add"}>
              Add channel
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
