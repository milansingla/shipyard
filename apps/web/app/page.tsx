"use client";

import Link from "next/link";

import { ErrorNote, HullName, Mono, StatusBadge, buttonClass } from "@/components/ui";
import { relativeTime, safeHttpUrl } from "@/lib/format";
import { isInProgress } from "@/lib/status";
import type { ProjectWithLatestDeployment } from "@/lib/types";
import { useApi } from "@/lib/useApi";

export default function ProjectsPage() {
  const { data: projects, error } = useApi<ProjectWithLatestDeployment[]>("/projects", {
    // Keep statuses fresh while anything is being deployed.
    pollMs: (list) => (list.some((p) => p.latestDeployment && isInProgress(p.latestDeployment.status)) ? 3_000 : null),
  });

  return (
    <>
      <div className="flex items-end justify-between gap-4 pb-8 pt-12">
        <h1 className="font-display text-5xl font-bold uppercase tracking-wide">Projects</h1>
        <Link href="/projects/new" className={buttonClass("primary")}>
          New project
        </Link>
      </div>

      {error && <ErrorNote title="Couldn't load your projects">{error.message}</ErrorNote>}

      {projects?.length === 0 && (
        <div className="border border-dashed border-rivet px-6 py-16 text-center">
          <p className="text-lg font-semibold">No projects yet</p>
          <p className="mt-1 text-ink-soft">Create one from a GitHub repository, then deploy it.</p>
          <Link href="/projects/new" className={`${buttonClass("primary")} mt-6`}>
            New project
          </Link>
        </div>
      )}

      {projects && projects.length > 0 && (
        <ul className="divide-y divide-rivet border-y border-rivet">
          {projects.map((project) => {
            const latest = project.latestDeployment;
            const url = latest?.status === "RUNNING" ? safeHttpUrl(latest.deploymentUrl) : null;
            return (
              <li key={project.id} className="grid gap-3 py-6 sm:grid-cols-[minmax(0,1fr)_12rem_14rem] sm:items-center">
                <div className="min-w-0">
                  <Link href={`/projects/${project.id}`} className="text-3xl hover:text-sea">
                    <HullName>{project.name}</HullName>
                  </Link>
                  {!project.organization.personal && (
                    <span className="ml-3 rounded-sm border border-rivet px-1.5 py-0.5 align-middle text-xs font-semibold text-ink-soft">
                      {project.organization.name}
                    </span>
                  )}
                  <p className="mt-2 truncate text-ink-soft">
                    <Mono>
                      {project.repositoryOwner}/{project.repositoryName} · {project.branch}
                    </Mono>
                  </p>
                </div>
                <div>
                  {latest ? (
                    <>
                      <StatusBadge status={latest.status} />
                      <p className="mt-1 text-xs text-ink-soft">{relativeTime(latest.createdAt)}</p>
                    </>
                  ) : (
                    <span className="text-sm text-ink-soft">Never deployed</span>
                  )}
                </div>
                <div className="truncate sm:text-right">
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer" className="font-mono text-sm underline decoration-rivet underline-offset-4 hover:decoration-ink">
                      {url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
