"use client";

import { ErrorNote, Label } from "@/components/ui";
import type { ProjectMetrics, ServiceMetrics } from "@/lib/types";
import { useApi } from "@/lib/useApi";

/** "3h 12m", "4d 2h". */
function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function seconds(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** The last hour of a value, as a line; nothing until there are two samples. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return <span className="text-xs text-ink-soft">collecting…</span>;
  const clamped = values.map((value) => Math.max(0, value));
  const max = Math.max(...clamped, 1);
  const points = clamped.map((value, i) => `${(i / (clamped.length - 1)) * 100},${28 - (value / max) * 26}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full" role="img" aria-label={label}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="text-sea" />
    </svg>
  );
}

function ServiceCard({ service }: { service: ServiceMetrics }) {
  const memoryShare = service.memoryMb !== null && service.memoryLimitMb ? service.memoryMb / service.memoryLimitMb : null;
  return (
    <li className="border border-rivet bg-plate p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{service.name}</span>
        <span className="text-xs text-ink-soft">
          {service.status === "RUNNING" ? `${service.running}/${service.replicas} running` : "not running"}
        </span>
      </div>
      {service.status === "RUNNING" ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt>
              <Label>CPU</Label>
            </dt>
            <dd className="tabular-nums">{service.cpuPercent === null ? "—" : `${Math.round(service.cpuPercent * 10) / 10}%`}</dd>
          </div>
          <div>
            <dt>
              <Label>Memory</Label>
            </dt>
            <dd className={`tabular-nums ${memoryShare !== null && memoryShare > 0.9 ? "text-oxide" : ""}`}>
              {service.memoryMb === null ? "—" : `${Math.round(service.memoryMb)} MB`}
              {service.memoryLimitMb !== null && <span className="text-ink-soft"> / {Math.round(service.memoryLimitMb)}</span>}
            </dd>
          </div>
          <div>
            <dt>
              <Label>Restarts</Label>
            </dt>
            <dd className={`tabular-nums ${service.restartCount ? "text-oxide" : ""}`}>{service.restartCount ?? "—"}</dd>
          </div>
          <div>
            <dt>
              <Label>Up</Label>
            </dt>
            <dd className="tabular-nums">{service.uptimeSeconds === null ? "—" : uptime(service.uptimeSeconds)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="sr-only">CPU over the last hour</dt>
            <dd>
              <Sparkline values={service.series.map((s) => s.cpuPercent)} label={`${service.name} CPU over the last hour`} />
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">Deploy it to see its numbers.</p>
      )}
    </li>
  );
}

/** Resource use per service (sampled every 30 s) and how deploys have gone. */
export function MetricsPanel({ projectId }: { projectId: string }) {
  const metrics = useApi<ProjectMetrics>(`/projects/${projectId}/metrics`, { pollMs: () => 30_000 });
  const history = metrics.data?.deployments;
  return (
    <section className="mt-12" aria-labelledby="metrics-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="metrics-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
          Metrics
        </h2>
        <p className="text-sm text-ink-soft">Production, refreshed every 30 seconds.</p>
      </div>
      {metrics.error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't load metrics">{metrics.error.message}</ErrorNote>
        </div>
      )}
      {metrics.data && (
        <>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {metrics.data.services.map((service) => (
              <ServiceCard key={service.serviceId} service={service} />
            ))}
          </ul>
          {history && history.total > 0 && (
            <p className="mt-4 text-sm text-ink-soft">
              Last 30 days: {history.total} deploys,{" "}
              {history.successRate === null ? "none finished" : `${Math.round(history.successRate * 100)}% succeeded`}; typical deploy{" "}
              {seconds(history.averageDeployMs)}, build {seconds(history.averageBuildMs)}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
