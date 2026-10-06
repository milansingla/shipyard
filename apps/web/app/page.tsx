"use client";

import Link from "next/link";

import { ArrowIcon } from "@/components/icons";
import { ErrorNote, Glow, HullName, Mono, StatusBadge, buttonClass } from "@/components/ui";
import { relativeTime, safeHttpUrl } from "@/lib/format";
import { isInProgress, statusInfo, type Tone } from "@/lib/status";
import type { ProjectWithLatestDeployment } from "@/lib/types";
import { useApi } from "@/lib/useApi";

export default function ProjectsPage() {
  const { data: projects, error } = useApi<ProjectWithLatestDeployment[]>("/projects", {
    // Keep statuses fresh while anything is being deployed.
    pollMs: (list) => (list.some((p) => p.latestDeployment && isInProgress(p.latestDeployment.status)) ? 3_000 : null),
  });

  const counts = countTones(projects ?? []);
  const latest = (projects ?? [])
    .filter((p) => p.latestDeployment)
    .sort((a, b) => Date.parse(b.latestDeployment!.createdAt) - Date.parse(a.latestDeployment!.createdAt))[0];

  return (
    <>
      <h1 className="page-title pb-6 pt-2">Projects</h1>

      {error && <ErrorNote title="Couldn't load your projects">{error.message}</ErrorNote>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        {/* Hero: what Shipyard does, and the fleet in four numbers. */}
        <section aria-label="Overview" className="glass relative flex min-h-[22rem] flex-col justify-between overflow-hidden rounded-[1.75rem] p-6 sm:p-8">
          <Glow />
          <div className="relative max-w-md">
            <p className="text-xs font-semibold text-ink-soft">Your fleet</p>
            <p className="display-wide mt-3 text-[clamp(2rem,4.4vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.015em]">
              Ship every
              <br />
              repository
            </p>
            <Link href="/projects/new" className={`${buttonClass("primary")} mt-7 h-11 px-8`}>
              New project
            </Link>
          </div>
          <div className="relative mt-8 flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-black/25 p-2 pl-4 backdrop-blur-xl sm:gap-4">
            <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 py-2 sm:grid-cols-4">
              <Stat value={projects?.length} label="Projects" swatch="bg-ink" />
              <Stat value={projects ? counts.live : undefined} label="Running" swatch="bg-sea" />
              <Stat value={projects ? counts.working : undefined} label="Deploying" swatch="bg-signal" />
              <Stat value={projects ? counts.failed : undefined} label="Failed" swatch="bg-oxide" />
            </dl>
            <Link
              href="/activity"
              aria-label="Activity"
              title="Activity"
              className="flex size-11 shrink-0 items-center justify-center self-center rounded-full bg-ink text-[#121214] transition-transform hover:translate-x-0.5"
            >
              <ArrowIcon />
            </Link>
          </div>
        </section>

        <div className="grid gap-4">
          <FleetCard projects={projects} counts={counts} />
          <LatestCard project={latest} />
        </div>
      </div>

      {projects?.length === 0 && (
        <div className="mt-4 rounded-[1.75rem] border border-dashed border-white/15 px-6 py-16 text-center">
          <p className="display-wide text-lg font-semibold">No projects yet</p>
          <p className="mt-1 text-ink-soft">Create one from a GitHub repository, then deploy it.</p>
          <Link href="/projects/new" className={`${buttonClass("primary")} mt-6`}>
            New project
          </Link>
        </div>
      )}

      {projects && projects.length > 0 && (
        <section aria-labelledby="projects-heading" className="panel mt-4">
          <h2 id="projects-heading" className="text-sm font-semibold text-ink-soft">
            Your projects
          </h2>
          <div aria-hidden className="mt-5 hidden grid-cols-[minmax(0,1fr)_12rem_14rem] gap-4 border-b border-rivet px-3 pb-3 text-xs text-ink-soft sm:grid">
            <span>Project</span>
            <span>Status</span>
            <span className="text-right">Address</span>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {projects.map((project) => {
              const latestDeployment = project.latestDeployment;
              const url = latestDeployment?.status === "RUNNING" ? safeHttpUrl(latestDeployment.deploymentUrl) : null;
              const tone = latestDeployment ? statusInfo(latestDeployment.status).tone : "idle";
              return (
                <li
                  key={project.id}
                  className="grid gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.035] p-3 transition-colors hover:bg-white/[0.07] sm:grid-cols-[minmax(0,1fr)_12rem_14rem] sm:items-center sm:gap-4"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <Monogram name={project.name} tone={tone} />
                    <div className="min-w-0">
                      <Link href={`/projects/${project.id}`} className="text-lg hover:text-sea">
                        <HullName>{project.name}</HullName>
                      </Link>
                      {!project.organization.personal && (
                        <span className="ml-2 rounded-full border border-rivet px-2 py-0.5 align-middle text-xs font-semibold text-ink-soft">
                          {project.organization.name}
                        </span>
                      )}
                      <p className="mt-1 truncate text-ink-soft">
                        <Mono className="text-xs">
                          {project.repositoryOwner}/{project.repositoryName} · {project.branch}
                        </Mono>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 sm:block">
                    {latestDeployment ? (
                      <>
                        <StatusBadge status={latestDeployment.status} />
                        <p className="text-xs text-ink-soft sm:mt-1.5 sm:pl-1">{relativeTime(latestDeployment.createdAt)}</p>
                      </>
                    ) : (
                      <span className="text-sm text-ink-soft">Never deployed</span>
                    )}
                  </div>
                  <div className="truncate sm:text-right">
                    {url && (
                      <a href={url} target="_blank" rel="noreferrer" className="font-mono text-sm text-ink-soft underline decoration-rivet underline-offset-4 hover:text-ink hover:decoration-ink">
                        {url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}

function countTones(projects: ProjectWithLatestDeployment[]): Record<Tone, number> {
  const counts: Record<Tone, number> = { live: 0, working: 0, failed: 0, idle: 0 };
  for (const project of projects) counts[project.latestDeployment ? statusInfo(project.latestDeployment.status).tone : "idle"] += 1;
  return counts;
}

function Stat({ value, label, swatch }: { value: number | undefined; label: string; swatch: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <dd className="display-wide order-first text-[1.75rem] font-semibold leading-none tabular-nums">{value ?? "—"}</dd>
      <dt className="flex items-center gap-1.5 text-xs text-ink-soft">
        <span aria-hidden className={`size-2 rounded-[3px] ${swatch}`} />
        {label}
      </dt>
    </div>
  );
}

const TONE_BAR: Record<Tone, string> = { live: "bg-sea", working: "bg-signal", failed: "bg-oxide", idle: "bg-white/20" };
const TONE_LABEL: Record<Tone, string> = { live: "Running", working: "Deploying", failed: "Failed", idle: "Stopped or new" };

/** How many projects are up, as a proportion bar with a legend. */
function FleetCard({ projects, counts }: { projects: ProjectWithLatestDeployment[] | undefined; counts: Record<Tone, number> }) {
  const total = projects?.length ?? 0;
  const tones = (["live", "working", "failed", "idle"] as const).filter((tone) => counts[tone] > 0);
  return (
    <section aria-labelledby="fleet-heading" className="glass rounded-[1.75rem] p-6">
      <h2 id="fleet-heading" className="text-sm font-semibold text-ink-soft">
        Running right now
      </h2>
      <p className="display-wide mt-3 text-4xl font-semibold tabular-nums">
        {projects ? counts.live : "—"}
        <span className="ml-1 text-lg text-ink-soft">/ {projects ? total : "—"}</span>
      </p>
      <div aria-hidden className="mt-5 flex h-3 gap-1 overflow-hidden rounded-full">
        {total === 0 ? (
          <span className="flex-1 rounded-full bg-white/10" />
        ) : (
          tones.map((tone) => <span key={tone} className={`rounded-full ${TONE_BAR[tone]}`} style={{ flexGrow: counts[tone] }} />)
        )}
      </div>
      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-soft">
        {tones.map((tone) => (
          <li key={tone} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-full ${TONE_BAR[tone]}`} />
            {TONE_LABEL[tone]} · {counts[tone]}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The most recent deployment across every project. */
function LatestCard({ project }: { project: ProjectWithLatestDeployment | undefined }) {
  const deployment = project?.latestDeployment;
  return (
    <section aria-labelledby="latest-heading" className="glass flex gap-4 rounded-[1.75rem] p-6">
      <div className="min-w-0 flex-1">
        <h2 id="latest-heading" className="text-sm font-semibold text-ink-soft">
          Latest deployment
        </h2>
        {project && deployment ? (
          <>
            <Link href={`/deployments/${deployment.id}`} className="mt-3 block text-2xl hover:text-sea">
              <HullName>{project.name}</HullName>
            </Link>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <StatusBadge status={deployment.status} />
              <span className="text-xs text-ink-soft">{relativeTime(deployment.createdAt)}</span>
            </div>
          </>
        ) : (
          <p className="mt-3 text-ink-soft">Nothing deployed yet.</p>
        )}
      </div>
      {project && deployment && (
        <div className="hidden w-28 shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border border-white/[0.06] bg-white/[0.05] p-3 text-center sm:flex">
          <Monogram name={project.name} tone={statusInfo(deployment.status).tone} />
          <Mono className="text-xs text-ink-soft">{deployment.commitSha ? deployment.commitSha.slice(0, 7) : deployment.branch}</Mono>
        </div>
      )}
    </section>
  );
}

const TONE_TILE: Record<Tone, string> = {
  live: "from-sea/90 to-[#4f7d2c]",
  working: "from-signal to-ember",
  failed: "from-oxide to-[#8a2416]",
  idle: "from-[#4a4a50] to-[#2a2a2e]",
};

/** A project's initial on a tile coloured by its state, standing in for a thumbnail. */
function Monogram({ name, tone }: { name: string; tone: Tone }) {
  return (
    <span aria-hidden className={`display-wide flex size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-xl font-bold text-[#121214] shadow-[inset_0_1px_0_rgb(255_255_255/0.3)] ${TONE_TILE[tone]}`}>
      {name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 1).toUpperCase() || "·"}
    </span>
  );
}
