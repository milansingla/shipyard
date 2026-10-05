"use client";

import { useEffect } from "react";

import { Label } from "@/components/ui";
import { duration } from "@/lib/format";
import { isInProgress, statusInfo } from "@/lib/status";
import type { DeploymentEvent, DeploymentStatus } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function describe(event: DeploymentEvent): string {
  if (event.type === "CREATED") return event.actor ? `Deploy started by ${event.actor}` : "Deploy started";
  const label = statusInfo(event.toStatus!).label;
  return event.actor ? `${label} · by ${event.actor}` : label;
}

/**
 * Everything that happened to a deployment, from the API's event log. Each row
 * shows how long the deployment stayed in that state, so a slow build or health
 * check stands out.
 */
export function History({ deploymentId, status }: { deploymentId: string; status: DeploymentStatus }) {
  const events = useApi<DeploymentEvent[]>(`/deployments/${deploymentId}/events`, {
    pollMs: () => (isInProgress(status) ? 3_000 : null),
  });
  const reload = events.reload;
  // A status change means a new event: fetch it now, including the final one.
  useEffect(() => void reload(), [status, reload]);

  const list = events.data ?? [];
  if (list.length === 0) return null;

  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading" className="font-display text-xl font-bold uppercase tracking-wide">
        History
      </h2>
      <ol className="mt-3 divide-y divide-rivet border-y border-rivet text-sm">
        {list.map((event, index) => {
          const next = list[index + 1];
          const failed = event.toStatus === "FAILED";
          const lasted = next ? duration(event.createdAt, next.createdAt) : isInProgress(status) ? "…" : null;
          return (
            <li key={event.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-baseline gap-x-4 py-2">
              <time dateTime={event.createdAt} className="font-mono text-xs tabular-nums text-ink-soft">
                {TIME.format(new Date(event.createdAt))}
              </time>
              <span className="min-w-0">
                <span className={failed ? "font-semibold text-oxide" : "font-semibold"}>{describe(event)}</span>
                {event.message && <span className="block break-words text-ink-soft">{event.message}</span>}
              </span>
              <span className="tabular-nums text-ink-soft">
                {lasted && event.type === "STATUS_CHANGED" && !failed && <Label>{lasted}</Label>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
