"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";

import { DraftScale } from "@/components/DraftScale";
import { LogPanel } from "@/components/LogPanel";
import { Button, ErrorNote, HullName, Label, Mono, StatusBadge } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { duration, relativeTime, safeHttpUrl, shortId, shortSha } from "@/lib/format";
import { isInProgress } from "@/lib/status";
import type { Deployment, Project } from "@/lib/types";
import { useApi } from "@/lib/useApi";

type Action = "stop" | "restart" | "redeploy";

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const deployment = useApi<Deployment>(`/deployments/${id}`, {
    pollMs: (d) => (isInProgress(d.status) ? 1_500 : null),
  });
  const d = deployment.data;
  const project = useApi<Project>(d ? `/projects/${d.projectId}` : null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  async function act(action: Action) {
    setBusy(action);
    setActionError(null);
    try {
      const result = await api<Deployment>(`/deployments/${id}/${action}`, { method: "POST" });
      // Redeploy creates a NEW deployment; follow it.
      if (action === "redeploy") return router.push(`/deployments/${result.id}`);
      await deployment.reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(null);
    }
  }

  if (deployment.error && !d) {
    return (
      <div className="pt-12">
        <ErrorNote title={deployment.error.status === 404 ? "Deployment not found" : "Couldn't load this deployment"}>
          {deployment.error.status === 404 ? "It may belong to a deleted project." : deployment.error.message}
        </ErrorNote>
      </div>
    );
  }
  if (!d) return null;

  const url = d.status === "RUNNING" ? safeHttpUrl(d.deploymentUrl) : null;
  const canStop = d.status === "RUNNING" || d.status === "HEALTHY";
  const canRestart = (d.status === "RUNNING" || d.status === "STOPPED") && d.containerId !== null;

  return (
    <div className="pt-12">
      <Link href={`/projects/${d.projectId}`} className="text-sm text-ink-soft hover:text-ink">
        ← {project.data?.name ?? "Project"}
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-6 border-b-2 border-ink pb-6">
        <div>
          <h1 className="flex flex-wrap items-baseline gap-x-4 text-[clamp(2.5rem,7vw,4.5rem)]">
            <HullName>{project.data?.name ?? "…"}</HullName>
            <span className="font-mono text-xl text-ink-soft">#{shortId(d.id)}</span>
          </h1>
          <div className="mt-3">
            <StatusBadge status={d.status} />
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          {canStop && (
            <Button variant="secondary" busy={busy === "stop"} disabled={busy !== null} onClick={() => void act("stop")}>
              Stop
            </Button>
          )}
          {canRestart && (
            <Button
              variant="secondary"
              busy={busy === "restart"}
              disabled={busy !== null}
              onClick={() => void act("restart")}
              title={d.status === "STOPPED" ? "Starts this version again and stops whichever version is running now." : undefined}
            >
              {busy === "restart" ? "Starting…" : d.status === "STOPPED" ? "Run this version again" : "Restart"}
            </Button>
          )}
          <Button busy={busy === "redeploy"} disabled={busy !== null || isInProgress(d.status)} onClick={() => void act("redeploy")}>
            Deploy latest commit
          </Button>
        </div>
      </div>

      {actionError && (
        <div className="mt-6">
          <ErrorNote title="That didn't work">{actionError.message}</ErrorNote>
        </div>
      )}

      <div className="mt-10 grid gap-12 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <DraftScale deployment={d} />

        <div className="flex min-w-0 flex-col gap-8">
          {d.status === "FAILED" && d.errorMessage && (
            <ErrorNote title="Why it failed">
              <p className="whitespace-pre-wrap break-words font-mono text-[0.8125rem]">{d.errorMessage}</p>
              <p className="mt-2 text-ink-soft">The build log below has the full output.</p>
            </ErrorNote>
          )}

          <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
            <Fact label="URL">
              {url ? (
                <a href={url} target="_blank" rel="noreferrer" className="break-all font-mono text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink">
                  {url}
                </a>
              ) : (
                <span className="text-ink-soft">{d.status === "STOPPED" ? "Stopped" : "Not live"}</span>
              )}
            </Fact>
            <Fact label="Commit">
              <Mono>{shortSha(d.commitSha)}</Mono>
            </Fact>
            <Fact label="Branch">
              <Mono>{d.branch}</Mono>
            </Fact>
            <Fact label="Started">{relativeTime(d.createdAt)}</Fact>
            <Fact label="Duration">
              <span className="tabular-nums">{duration(d.startedAt, d.finishedAt)}</span>
            </Fact>
            <Fact label="Port">
              <Mono>{d.containerPort ?? "—"}</Mono>
            </Fact>
          </dl>

          <LogPanel deploymentId={d.id} status={d.status} />
        </div>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt>
        <Label>{label}</Label>
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
