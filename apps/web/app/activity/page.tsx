"use client";

import Link from "next/link";

import { ErrorNote, Mono } from "@/components/ui";
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
  const log = useApi<AuditEntry[]>("/audit-logs?limit=100");

  return (
    <div className="pt-12">
      <h1 className="font-display text-5xl font-bold uppercase">Activity</h1>
      <p className="mt-3 text-ink-soft">Everything that changed on your projects and account, newest first.</p>

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
