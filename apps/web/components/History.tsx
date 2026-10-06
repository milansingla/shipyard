"use client";

import Link from "next/link";
import { useEffect } from "react";

import { duration, shortId } from "@/lib/format";
import { isInProgress, statusInfo } from "@/lib/status";
import type { DeploymentEvent, DeploymentStatus } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function describe(event: DeploymentEvent): string {
  if (event.type === "CREATED") return event.actor ? `Deploy started by ${event.actor}` : "Deploy started";
  if (event.type === "ROLLBACK") return event.actor ? `Rollback by ${event.actor}` : "Rollback";
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
    <section aria-labelledby="history-heading" className="panel">
      <h2 id="history-heading" className="section-title">
        History
      </h2>
      <ol className="mt-3 divide-y divide-rivet border-t border-rivet text-sm">
        {list.map((event, index) => {
          // How long it stayed in this status: until the next status change (other events don't end it).
          const next = list.slice(index + 1).find((later) => later.type === "STATUS_CHANGED");
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
                {lasted && event.type === "STATUS_CHANGED" && !failed && <span className="font-mono text-xs">{lasted}</span>}
                {event.relatedDeploymentId && (
                  <Link href={`/deployments/${event.relatedDeploymentId}`} className="font-mono text-xs underline decoration-rivet underline-offset-4 hover:decoration-ink">
                    #{shortId(event.relatedDeploymentId)}
                  </Link>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
