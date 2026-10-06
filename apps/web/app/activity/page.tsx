"use client";

import Link from "next/link";
import { useState } from "react";

import { ErrorNote, Label, Mono } from "@/components/ui";
import { relativeTime, shortId } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";
import { useApi } from "@/lib/useApi";

/** How each action reads, given its details. */
const DESCRIBE: Record<string, (m: AuditEntry["metadata"]) => string> = {
  PROJECT_CREATED: (m) => `created the project from ${m.repository}`,
  PROJECT_SETTINGS_CHANGED: (m) => `changed settings (${String(m.settings).replaceAll(",", ", ")})`,
  PROJECT_DELETED: () => "deleted the project",
  DEPLOYMENT_STARTED: (m) => (m.trigger === "PUSH" ? `deploy started by a push to ${m.branch}` : "started a deploy"),
  DEPLOYMENT_SUCCEEDED: () => "deployment went live",
  DEPLOYMENT_FAILED: (m) => `deployment failed${m.failedStage ? ` while ${String(m.failedStage).toLowerCase().replace("_", " ")}` : ""}`,
  ROLLBACK: () => "rolled back",
  ENV_VAR_SET: (m) => `set ${m.secret ? "secret " : ""}${m.key}`,
  ENV_VAR_DELETED: (m) => `deleted ${m.key}`,
  DOMAIN_ADDED: (m) => `added the domain ${m.hostname}`,
  DOMAIN_REMOVED: (m) => `removed the domain ${m.hostname}`,
  API_KEY_CREATED: (m) => `created the API key “${m.name}”`,
  API_KEY_REVOKED: (m) => `revoked the API key “${m.name}”`,
};

/** Who did what: the audit log of your projects and your account. */
export default function ActivityPage() {
  const [text, setText] = useState("");
  const [action, setAction] = useState("");
  const query = new URLSearchParams({ limit: "100", ...(text.trim().length >= 2 && { q: text.trim() }), ...(action && { action }) });
  const log = useApi<AuditEntry[]>(`/audit-logs?${query.toString()}`);

  return (
    <div className="pt-12">
      <h1 className="font-display text-5xl font-bold uppercase">Activity</h1>
      <p className="mt-3 text-ink-soft">Everything that changed on your projects and account, newest first.</p>

      <div className="mt-6 flex flex-wrap items-end gap-3" role="search">
        <label className="flex flex-col gap-2">
          <Label>Search</Label>
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="project, variable, domain…"
            className="h-10 w-64 border border-rivet bg-plate px-3 text-sm focus:border-ink"
          />
        </label>
        <label className="flex flex-col gap-2">
          <Label>What</Label>
          <select value={action} onChange={(event) => setAction(event.target.value)} className="h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink">
            <option value="">Everything</option>
            <option value="DEPLOYMENT_STARTED,DEPLOYMENT_SUCCEEDED,DEPLOYMENT_FAILED,ROLLBACK">Deploys and rollbacks</option>
            <option value="DEPLOYMENT_FAILED">Failed deploys</option>
            <option value="ENV_VAR_SET,ENV_VAR_DELETED">Variables and secrets</option>
            <option value="DOMAIN_ADDED,DOMAIN_REMOVED">Domains</option>
            <option value="MEMBER_ADDED,MEMBER_ROLE_CHANGED,MEMBER_REMOVED,TEAM_CREATED,TEAM_CHANGED,TEAM_DELETED,SERVICE_ACCOUNT_CREATED,SERVICE_ACCOUNT_DELETED">People and access</option>
            <option value="API_KEY_CREATED,API_KEY_REVOKED">API keys</option>
            <option value="PROJECT_CREATED,PROJECT_SETTINGS_CHANGED,PROJECT_DELETED">Projects</option>
          </select>
        </label>
      </div>

      {log.error && (
        <div className="mt-6">
          <ErrorNote title="Couldn't load the activity">{log.error.message}</ErrorNote>
        </div>
      )}
      {log.data?.length === 0 && <p className="mt-8 text-ink-soft">Nothing yet.</p>}

      {log.data && log.data.length > 0 && (
        <ol className="mt-8 divide-y divide-rivet border-y border-rivet text-sm">
          {log.data.map((entry) => {
            const deploymentId = (entry.metadata.deploymentId ?? entry.metadata.toDeploymentId) as string | undefined;
            return (
              <li key={entry.id} className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <time dateTime={entry.createdAt} className="text-ink-soft" title={new Date(entry.createdAt).toLocaleString()}>
                  {relativeTime(entry.createdAt)}
                </time>
                <p className="min-w-0">
                  <span className="font-semibold">{entry.actor ?? "Shipyard"}</span>{" "}
                  {(DESCRIBE[entry.action] ?? (() => entry.action))(entry.metadata)}
                  {entry.projectName && (
                    <>
                      <span className="text-ink-soft"> in </span>
                      {entry.action === "PROJECT_DELETED" ? (
                        <span className="font-semibold">{entry.projectName}</span>
                      ) : (
                        <Link href={`/projects/${entry.projectId}`} className="font-semibold underline decoration-rivet underline-offset-4 hover:decoration-ink">
                          {entry.projectName}
                        </Link>
                      )}
                    </>
                  )}
                  {deploymentId && (
                    <Link href={`/deployments/${deploymentId}`} className="ml-2 font-mono text-xs underline decoration-rivet underline-offset-4">
                      #{shortId(deploymentId)}
                    </Link>
                  )}
                  {entry.action === "PROJECT_CREATED" && entry.metadata.branch && <Mono className="ml-2 text-ink-soft">{String(entry.metadata.branch)}</Mono>}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
