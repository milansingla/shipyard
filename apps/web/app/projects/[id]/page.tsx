"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { RepositoryAdvisor } from "@/components/Assistant";
import { CronPanel } from "@/components/CronPanel";
import { DomainsPanel } from "@/components/DomainsPanel";
import { EnvironmentsPanel } from "@/components/EnvironmentsPanel";
import { MetricsPanel } from "@/components/MetricsPanel";
import { EnvironmentPanel } from "@/components/EnvironmentPanel";
import { ServicesPanel, confirmDeletion } from "@/components/ServicesPanel";
import { ProjectSettings } from "@/components/ProjectSettings";
import { Button, ErrorNote, Glow, HullName, Label, Mono, StatusBadge } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { duration, relativeTime, safeHttpUrl, shortId, shortSha } from "@/lib/format";
import { isInProgress } from "@/lib/status";
import type { Deployment, ProjectEnvironment, ProjectWithLatestDeployment, Service } from "@/lib/types";
import { can } from "@/lib/roles";
import { useApi } from "@/lib/useApi";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useApi<ProjectWithLatestDeployment>(`/projects/${id}`);
  const services = useApi<Service[]>(`/projects/${id}/services`, {
    pollMs: (list) => (list.some((s) => s.latestDeployment && isInProgress(s.latestDeployment.status)) ? 3_000 : null),
  });
  // Names for the history's environment tags (dev, pr-12).
  const environments = useApi<ProjectEnvironment[]>(`/projects/${id}/environments`);
  const history = useApi<Deployment[]>(`/projects/${id}/deployments?limit=50`, {
    pollMs: (list) => (list.some((d) => isInProgress(d.status)) ? 3_000 : null),
  });
  const [busy, setBusy] = useState<"deploy" | "delete" | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  async function run(action: "deploy" | "delete", fn: () => Promise<void>) {
    setBusy(action);
    setActionError(null);
    try {
      await fn();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
      setBusy(null);
    }
  }

  const deploy = () =>
    run("deploy", async () => {
      const deployment = await api<Deployment>(`/projects/${id}/deploy`, { method: "POST" });
      router.push(`/deployments/${deployment.id}`);
    });

  const remove = () => {
    const name = project.data?.name ?? "this project";
    const query = confirmDeletion(
      name,
      name,
      (services.data ?? []).flatMap((service) => service.volumes),
      "Its containers, images, logs and deployment history are removed. This can't be undone.",
    );
    if (query === null) return;
    void run("delete", async () => {
      await api(`/projects/${id}${query}`, { method: "DELETE" });
      router.push("/");
    });
  };

  if (project.error) {
    return (
      <div className="pt-2">
        <ErrorNote title={project.error.status === 404 ? "Project not found" : "Couldn't load this project"}>
          {project.error.status === 404 ? "It may have been deleted." : project.error.message}
        </ErrorNote>
      </div>
    );
  }
  if (!project.data) return null;
  const p = project.data;
  const serviceName = new Map((services.data ?? []).map((service) => [service.id, service.name]));
  const multiService = serviceName.size > 1;
  const primary = services.data?.find((service) => service.primary);
  const running = history.data?.find((d) => d.status === "RUNNING" && !d.environmentId && (!primary || d.serviceId === primary.id));
  const runningUrl = safeHttpUrl(running?.deploymentUrl ?? null);

  return (
    <div className="pt-2">
      <Link href="/" className="text-sm text-ink-soft hover:text-ink">
        ← Projects
      </Link>

      <div className="panel relative mt-4 overflow-hidden">
      <Glow className="opacity-70" />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <p className="mb-3 text-xs font-semibold text-ink-soft">Project</p>
          <h1 className="text-[clamp(2rem,5.5vw,3.75rem)]">
            <HullName>{p.name}</HullName>
          </h1>
          <p className="mt-3 text-ink-soft">
            <a
              href={`https://github.com/${p.repositoryOwner}/${p.repositoryName}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-sm hover:text-ink"
            >
              {p.repositoryOwner}/{p.repositoryName}
            </a>
            <Mono className="ml-3">branch {p.branch}</Mono>
            {!p.organization.personal && (
              <span className="ml-3 text-sm">
                in <span className="font-semibold">{p.organization.name}</span> · you are {p.role.toLowerCase()}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {can(p.role, "ADMIN") && (
            <Button variant="danger" busy={busy === "delete"} disabled={busy !== null} onClick={remove}>
              Delete project
            </Button>
          )}
          {can(p.role, "DEVELOPER") && (
            <Button busy={busy === "deploy"} disabled={busy !== null} onClick={() => void deploy()}>
              {busy === "deploy" ? "Starting…" : "Deploy latest commit"}
            </Button>
          )}
        </div>
      </div>

      <div className="relative mt-6 flex w-fit max-w-full flex-wrap items-center gap-3 glass-inset rounded-2xl px-4 py-3 text-sm">
        <Label>Live at</Label>
        {runningUrl ? (
          <a href={runningUrl} target="_blank" rel="noreferrer" className="break-all font-mono text-sea underline decoration-sea/40 underline-offset-4 hover:decoration-sea">
            {runningUrl}
          </a>
        ) : (
          <span className="text-ink-soft">Nothing running</span>
        )}
      </div>
      </div>

      {actionError && (
        <div className="mt-6">
          <ErrorNote title={busy === "delete" ? "Couldn't delete the project" : "Couldn't start a deployment"}>
            {actionError.message}
          </ErrorNote>
        </div>
      )}

      <PushDeploySetup branch={p.branch} />

      <ServicesPanel
        projectId={p.id}
        services={services}
        canDeploy={can(p.role, "DEVELOPER")}
        canEdit={can(p.role, "ADMIN")}
        onDeployed={(deployment) => router.push(`/deployments/${deployment.id}`)}
      />

      <MetricsPanel projectId={p.id} />

      <EnvironmentsPanel
        projectId={p.id}
        productionBranch={p.branch}
        services={services.data ?? []}
        canEdit={can(p.role, "ADMIN")}
        canDeploy={can(p.role, "DEVELOPER")}
        onDeployed={(deployment) => router.push(`/deployments/${deployment.id}`)}
      />

      <DomainsPanel projectId={p.id} canEdit={can(p.role, "ADMIN")} />

      <CronPanel projectId={p.id} services={services.data ?? []} canEdit={can(p.role, "ADMIN")} canRun={can(p.role, "DEVELOPER")} />

      <RepositoryAdvisor projectId={p.id} canSuggestDockerfile={can(p.role, "DEVELOPER")} />

      {/* Remounted when services change: adding a database adds its variables. */}
      <EnvironmentPanel
        key={(services.data ?? []).map((service) => service.id).join()}
        projectId={p.id}
        services={services.data ?? []}
        canEdit={can(p.role, "DEVELOPER")}
      />

      <ProjectSettings project={p} canEdit={can(p.role, "ADMIN")} onSaved={() => void project.reload()} />

      <section className="panel mt-6" aria-labelledby="deployments-heading">
      <h2 id="deployments-heading" className="section-title">Deployments</h2>
      {history.data?.length === 0 && <p className="mt-4 text-ink-soft">No deployments yet. Deploy the latest commit to start.</p>}
      {history.data && history.data.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-rivet">
              <tr>
                {["Status", "Deployment", ...(multiService ? ["Service"] : []), "Commit", "Started", "Duration"].map((h) => (
                  <th key={h} scope="col" className="py-2 pr-4 font-normal">
                    <Label>{h}</Label>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-rivet">
              {history.data.map((d) => (
                <tr key={d.id} className="group">
                  <td className="py-3 pr-4">
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="py-3 pr-4">
                    <Link href={`/deployments/${d.id}`} className="font-mono underline decoration-rivet underline-offset-4 group-hover:decoration-ink">
                      {shortId(d.id)}
                    </Link>
                    {d.environmentId && (
                      <span className="ml-2 rounded-full bg-sea-wash px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-sea">
                        {environments.data?.find((environment) => environment.id === d.environmentId)?.name ?? "env"}
                      </span>
                    )}
                    {d.trigger === "PUSH" && (
                      <span className="ml-2 rounded-full border border-rivet px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-soft">
                        push
                      </span>
                    )}
                  </td>
                  {multiService && <td className="py-3 pr-4">{serviceName.get(d.serviceId) ?? "—"}</td>}
                  <td className="py-3 pr-4">
                    <Mono>{shortSha(d.commitSha)}</Mono>
                  </td>
                  <td className="py-3 pr-4 text-ink-soft">{relativeTime(d.createdAt)}</td>
                  <td className="py-3 pr-4 tabular-nums text-ink-soft">{duration(d.startedAt, d.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </section>
    </div>
  );
}

/** How to make pushes deploy this project. Collapsed: it's set up once per repository. */
function PushDeploySetup({ branch }: { branch: string }) {
  // The webhook URL is this dashboard's own origin: it proxies /api to the API.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const payloadUrl = `${origin}/api/webhooks/github`;

  return (
    <details className="panel mt-6 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer items-center justify-between gap-4 text-sm">
        <span>
          <span className="font-semibold">Deploy on push</span>
          <span className="ml-2 text-ink-soft">Each push to {branch} deploys automatically, once the webhook is set up.</span>
        </span>
        <span aria-hidden className="text-ink-soft">Set up ▾</span>
      </summary>
      <div className="mt-4 grid gap-4 text-sm sm:grid-cols-[12rem_1fr]">
        <p className="text-ink-soft sm:col-span-2">
          In the GitHub repository, open <strong>Settings → Webhooks → Add webhook</strong> and enter:
        </p>
        <Label>Payload URL</Label>
        <Mono className="break-all">{payloadUrl}</Mono>
        <Label>Content type</Label>
        <Mono>application/json</Mono>
        <Label>Secret</Label>
        <span>
          The value of <Mono>GITHUB_WEBHOOK_SECRET</Mono> in this server&apos;s <Mono>.env</Mono>
        </span>
        <Label>Events</Label>
        <span>Just the push event</span>
        <p className="text-ink-soft sm:col-span-2">
          GitHub must be able to reach this URL. On your own machine, forward it with a tunnel (for example{" "}
          <Mono>smee.io</Mono> or <Mono>cloudflared tunnel</Mono>) and use the tunnel&apos;s URL instead.
        </p>
      </div>
    </details>
  );
}
