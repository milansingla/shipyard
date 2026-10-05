"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { Deployment, GitHubRepository, Organization, Page, Project } from "@/lib/types";
import { can } from "@/lib/roles";
import { useApi } from "@/lib/useApi";

export default function NewProjectPage() {
  const [repo, setRepo] = useState<GitHubRepository | null>(null);

  return (
    <div className="pt-12">
      <Link href="/" className="text-sm text-ink-soft hover:text-ink">
        ← Projects
      </Link>
      <h1 className="mt-4 font-display text-5xl font-bold uppercase tracking-wide">New project</h1>

      <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <RepositoryPicker selected={repo} onSelect={setRepo} />
        {repo ? (
          <CreateForm key={repo.fullName} repo={repo} />
        ) : (
          <p className="text-ink-soft lg:pt-9">Choose a repository to deploy.</p>
        )}
      </div>
    </div>
  );
}

function RepositoryPicker({
  selected,
  onSelect,
}: {
  selected: GitHubRepository | null;
  onSelect: (repo: GitHubRepository) => void;
}) {
  const [pages, setPages] = useState<Array<Page<GitHubRepository>>>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  async function loadPage(page: number) {
    setLoading(true);
    try {
      const next = await api<Page<GitHubRepository>>(`/github/repos?page=${page}`);
      setPages((current) => [...current.slice(0, page - 1), next]);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPage(1);
  }, []);

  const repos = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? repos.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : repos;
  }, [repos, filter]);
  const hasMore = pages.at(-1)?.hasNextPage ?? false;

  return (
    <section aria-labelledby="repo-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="repo-heading">
          <Label>Repository</Label>
        </h2>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter repositories"
          aria-label="Filter repositories"
          className="h-9 w-56 border-b border-rivet bg-transparent px-1 text-sm outline-none focus:border-ink"
        />
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't load your repositories">{error.message}</ErrorNote>
        </div>
      )}

      <ul className="mt-3 divide-y divide-rivet border-y border-rivet">
        {visible.map((repo) => {
          const isSelected = selected?.fullName === repo.fullName;
          return (
            <li key={repo.fullName}>
              <button
                type="button"
                disabled={!repo.deployable}
                aria-pressed={isSelected}
                onClick={() => onSelect(repo)}
                className={`flex w-full items-center justify-between gap-4 px-3 py-3 text-left transition-colors disabled:cursor-not-allowed ${
                  isSelected ? "bg-ink text-plate" : "hover:bg-plate disabled:text-ink-soft disabled:hover:bg-transparent"
                }`}
              >
                <Mono className="truncate">{repo.fullName}</Mono>
                <span className={`shrink-0 text-xs ${isSelected ? "text-plate/70" : "text-ink-soft"}`}>
                  {repo.deployable ? `updated ${relativeTime(repo.updatedAt)}` : "Private: not supported yet"}
                </span>
              </button>
            </li>
          );
        })}
        {pages.length > 0 && visible.length === 0 && (
          <li className="px-3 py-6 text-sm text-ink-soft">
            {repos.length === 0 ? "Your GitHub account has no repositories." : `No loaded repository matches "${filter}".`}
          </li>
        )}
      </ul>

      {(hasMore || loading) && (
        <div className="mt-4">
          <Button variant="secondary" busy={loading} onClick={() => void loadPage(pages.length + 1)}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </section>
  );
}

function CreateForm({ repo }: { repo: GitHubRepository }) {
  const router = useRouter();
  const branches = useApi<Page<string>>(`/github/repos/${repo.owner}/${repo.name}/branches`);
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [name, setName] = useState(repo.name);
  const organizations = useApi<Organization[]>("/organizations");
  const [organizationId, setOrganizationId] = useState("");
  // Where you may create projects: organizations where you are at least a DEVELOPER.
  const targets = (organizations.data ?? []).filter((org) => can(org.role, "DEVELOPER"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function createAndDeploy() {
    setBusy(true);
    setError(null);
    let project: Project | null = null;
    try {
      project = await api<Project>("/projects", {
        method: "POST",
        body: {
          repositoryUrl: repo.repositoryUrl,
          branch,
          name: name.trim() || undefined,
          organizationId: organizationId || undefined,
        },
      });
      const deployment = await api<Deployment>(`/projects/${project.id}/deploy`, { method: "POST" });
      router.push(`/deployments/${deployment.id}`);
    } catch (caught) {
      setBusy(false);
      // Created but the deploy request failed: the project page can retry it.
      if (project) return router.push(`/projects/${project.id}`);
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    }
  }

  const branchOptions = branches.data?.items ?? [repo.defaultBranch];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void createAndDeploy();
      }}
      className="flex flex-col gap-6 lg:sticky lg:top-8 lg:self-start"
    >
      <div>
        <Label>Deploying</Label>
        <p className="mt-1 break-all font-mono text-sm">{repo.fullName}</p>
      </div>

      <label className="flex flex-col gap-2">
        <Label>Branch</Label>
        <select
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          className="h-10 border border-rivet bg-plate px-3 font-mono text-sm focus:border-ink"
        >
          {branchOptions.map((option) => (
            <option key={option} value={option}>
              {option}
              {option === repo.defaultBranch ? " (default)" : ""}
            </option>
          ))}
        </select>
        {branches.error && <span className="text-xs text-oxide">{branches.error.message}</span>}
      </label>

      {targets.length > 1 && (
        <label className="flex flex-col gap-2">
          <Label>Owner</Label>
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            className="h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink"
          >
            {targets.map((org) => (
              <option key={org.id} value={org.personal ? "" : org.id}>
                {org.personal ? `${org.name} (personal)` : org.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-2">
        <Label>Project name</Label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          className="h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink"
        />
        <span className="text-xs text-ink-soft">Used in container names. Must be unique on this Shipyard.</span>
      </label>

      {error && <ErrorNote title="Couldn't create the project">{error.message}</ErrorNote>}

      <Button type="submit" busy={busy}>
        {busy ? "Creating…" : "Create and deploy"}
      </Button>
      <p className="text-xs text-ink-soft">
        Shipyard uses the repository&apos;s Dockerfile, or generates one for Node.js apps.
      </p>
    </form>
  );
}
