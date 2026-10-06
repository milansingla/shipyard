"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { can } from "@/lib/roles";
import type { Organization, OrgRole, OrgTeam, ProjectWithLatestDeployment } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

/**
 * Teams inside an organization: groups of its members granted a role on
 * chosen projects, on top of their organization role.
 */
export function OrgTeams({ organization }: { organization: Organization }) {
  const teams = useApi<OrgTeam[]>(`/organizations/${organization.id}/teams`);
  const projects = useApi<ProjectWithLatestDeployment[]>("/projects");
  const own = (projects.data ?? []).filter((project) => project.organization?.id === organization.id);
  const admin = can(organization.role, "ADMIN");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await teams.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  }

  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await api(`/organizations/${organization.id}/teams`, { method: "POST", body: { name: name.trim() } });
      setName("");
    });
  };

  return (
    <section className="mt-12" aria-labelledby="org-teams-heading">
      <h2 id="org-teams-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
        Teams
      </h2>
      <p className="mt-1 text-sm text-ink-soft">Give a group of members more access to some projects than their role gives them.</p>
      {teams.data?.length === 0 && <p className="mt-3 text-sm text-ink-soft">No teams.</p>}
      <ul className="mt-4 space-y-4">
        {(teams.data ?? []).map((team) => (
          <li key={team.id} className="border border-rivet bg-plate p-4 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">{team.name}</span>
              {admin && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => window.confirm(`Delete the team ${team.name}? Its members keep their organization role.`) && void act(() => api(`/teams/${team.id}`, { method: "DELETE" }))}
                  className="text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                >
                  Delete<span className="sr-only"> {team.name}</span>
                </button>
              )}
            </div>
            <p className="mt-2 text-ink-soft">
              {team.members.length === 0 ? "No members." : team.members.map((member) => member.login).join(", ")}
            </p>
            {team.grants.length > 0 && (
              <ul className="mt-2">
                {team.grants.map((grant) => (
                  <li key={grant.projectId} className="flex flex-wrap items-center gap-2">
                    <span>
                      {grant.role.toLowerCase()} on <span className="font-semibold">{grant.projectName}</span>
                    </span>
                    {admin && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => api(`/teams/${team.id}/projects/${grant.projectId}`, { method: "DELETE" }))}
                        className="text-xs underline decoration-rivet underline-offset-4"
                      >
                        Remove<span className="sr-only"> access to {grant.projectName}</span>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {admin && <TeamEditor team={team} projects={own} busy={busy} act={act} />}
          </li>
        ))}
      </ul>
      {admin && (
        <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-2">
            <Label>New team</Label>
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} placeholder="frontend" className={FIELD} />
          </label>
          <Button type="submit" busy={busy}>
            Create team
          </Button>
        </form>
      )}
      {error && (
        <div className="mt-4">
          <ErrorNote title="That didn't work">{error.message}</ErrorNote>
        </div>
      )}
    </section>
  );
}

function TeamEditor({
  team,
  projects,
  busy,
  act,
}: {
  team: OrgTeam;
  projects: ProjectWithLatestDeployment[];
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [login, setLogin] = useState("");
  const [projectId, setProjectId] = useState("");
  const [role, setRole] = useState<OrgRole>("DEVELOPER");
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-rivet pt-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await api(`/teams/${team.id}/members`, { method: "POST", body: { login: login.trim() } });
            setLogin("");
          });
        }}
        className="flex items-end gap-2"
      >
        <label className="flex flex-col gap-1">
          <Label>Add member</Label>
          <input value={login} onChange={(event) => setLogin(event.target.value)} required placeholder="GitHub login" className={`${FIELD} w-40`} />
        </label>
        <Button type="submit" variant="secondary" disabled={busy}>
          Add
        </Button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!projectId) return;
          void act(() => api(`/teams/${team.id}/projects/${projectId}`, { method: "PUT", body: { role } }));
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1">
          <Label>Grant</Label>
          <select value={role} onChange={(event) => setRole(event.target.value as OrgRole)} className={FIELD}>
            <option value="VIEWER">viewer</option>
            <option value="DEVELOPER">developer</option>
            <option value="ADMIN">admin</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <Label>On project</Label>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} required className={`${FIELD} w-44`}>
            <option value="">Choose…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={busy}>
          Grant
        </Button>
      </form>
    </div>
  );
}
