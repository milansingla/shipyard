"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isInProgress } from "@/lib/status";
import type { DeploymentLogs, DeploymentStatus } from "@/lib/types";
import { useApi } from "@/lib/useApi";

type LogType = "build" | "runtime";

const TABS: Array<{ type: LogType; label: string }> = [
  { type: "build", label: "Build" },
  { type: "runtime", label: "App output" },
];

/** Build log while deploying, then the app's own output. Refreshes while there is something new to see. */
export function LogPanel({ deploymentId, status }: { deploymentId: string; status: DeploymentStatus }) {
  const [type, setType] = useState<LogType>(status === "RUNNING" ? "runtime" : "build");
  const live = type === "build" ? isInProgress(status) : status === "RUNNING" || status === "HEALTHY";

  const { data, error } = useApi<DeploymentLogs>(
    `/deployments/${deploymentId}/logs?type=${type}${type === "runtime" ? "&tail=500" : ""}`,
    { pollMs: () => (live ? 2_000 : null) },
  );

  // Follow new output, but only if the reader is already at the bottom.
  const scroller = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data?.content]);
  useEffect(() => {
    stick.current = true;
  }, [type]);

  return (
    <section aria-label="Logs" className="overflow-hidden rounded-sm bg-ink text-plate">
      <div role="tablist" className="flex items-center gap-1 border-b border-white/10 px-2">
        {TABS.map((tab) => (
          <button
            key={tab.type}
            type="button"
            role="tab"
            aria-selected={type === tab.type}
            onClick={() => setType(tab.type)}
            className={`-mb-px border-b-2 px-3 py-3 text-sm font-semibold transition-colors ${
              type === tab.type ? "border-signal text-plate" : "border-transparent text-plate/60 hover:text-plate"
            }`}
          >
            {tab.label}
          </button>
        ))}
        {live && (
          <span className="ml-auto flex items-center gap-2 pr-2 text-xs text-plate/70">
            <span aria-hidden className="signal-pulse size-2 rounded-full bg-signal" /> Live
          </span>
        )}
      </div>
      <pre
        ref={scroller}
        role="tabpanel"
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="h-[28rem] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[0.78rem] leading-relaxed"
      >
        {error
          ? error.message
          : data?.message
            ? data.message
            : data?.content || (data ? "No output yet." : "Loading…")}
      </pre>
    </section>
  );
}
