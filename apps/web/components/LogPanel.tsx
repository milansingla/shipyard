"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import { isInProgress } from "@/lib/status";
import type { DeploymentLogs, DeploymentStatus } from "@/lib/types";

type LogType = "build" | "runtime";

const TABS: Array<{ type: LogType; label: string }> = [
  { type: "build", label: "Build" },
  { type: "runtime", label: "App output" },
];

/** Statuses in which the app's container is running and may print output. */
const CONTAINER_UP: DeploymentStatus[] = ["HEALTH_CHECKING", "HEALTHY", "ROUTING", "RUNNING"];

/** The browser keeps at most this much of a long-running app's output. */
const MAX_CHARS = 1_000_000;

interface LogState {
  content: string | null;
  message?: string;
  error?: ApiError;
}

/**
 * Build log while deploying, then the app's own output. While there is
 * something new to see, the API streams it (Server-Sent Events); otherwise
 * the stored log is fetched once.
 */
export function LogPanel({ deploymentId, status }: { deploymentId: string; status: DeploymentStatus }) {
  const [type, setType] = useState<LogType>(status === "RUNNING" ? "runtime" : "build");
  const live = type === "build" ? isInProgress(status) : CONTAINER_UP.includes(status);
  const [log, setLog] = useState<LogState>({ content: null });
  const query = `type=${type}${type === "runtime" ? "&tail=500" : ""}`;

  useEffect(() => {
    setLog({ content: null });
    if (!live) {
      let cancelled = false;
      api<DeploymentLogs>(`/deployments/${deploymentId}/logs?${query}`).then(
        (data) => !cancelled && setLog({ content: data.content, message: data.message }),
        (error: unknown) => !cancelled && setLog({ content: null, error: error instanceof ApiError ? error : undefined }),
      );
      return () => void (cancelled = true);
    }

    const source = new EventSource(`/api/deployments/${deploymentId}/logs/stream?${query}`);
    // Every connection (also a reconnect) starts with a full snapshot: start over.
    source.onopen = () => setLog({ content: "" });
    source.addEventListener("log", (event) => {
      const { text } = JSON.parse(event.data) as { text: string };
      setLog((previous) => ({ content: ((previous.content ?? "") + text).slice(-MAX_CHARS) }));
    });
    source.addEventListener("end", (event) => {
      source.close();
      const { message } = JSON.parse(event.data) as { message?: string };
      if (message) setLog((previous) => ({ ...previous, message }));
    });
    return () => source.close();
  }, [deploymentId, query, live]);

  const data = log.content === null && !log.message ? undefined : log;
  const error = log.error;

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
    <section aria-label="Logs" className="overflow-hidden rounded-3xl border border-white/[0.07] bg-console text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
      <div role="tablist" className="flex items-center gap-1 border-b border-white/[0.07] px-3">
        {TABS.map((tab) => (
          <button
            key={tab.type}
            type="button"
            role="tab"
            aria-selected={type === tab.type}
            onClick={() => setType(tab.type)}
            className={`-mb-px border-b-2 px-3 py-3 text-sm font-semibold transition-colors ${
              type === tab.type ? "border-signal text-ink" : "border-transparent text-ink-soft hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
        {live && (
          <span className="ml-auto flex items-center gap-2 pr-2 text-xs text-ink-soft">
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
        className="h-[28rem] overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-[0.78rem] leading-relaxed text-ink/90"
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
