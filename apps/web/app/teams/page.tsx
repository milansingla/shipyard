"use client";

import { type FormEvent, useState } from "react";

import { OrgTeams } from "@/components/OrgTeams";
import { ServiceAccounts } from "@/components/ServiceAccounts";
import { Button, ErrorNote, Label } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { can } from "@/lib/roles";
import type { Member, OrgRole, Organization } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const ROLES: Array<{ role: OrgRole; says: string }> = [
  { role: "VIEWER", says: "Reads projects, deployments and logs" },
  { role: "DEVELOPER", says: "Deploys, rolls back, changes variables" },
  { role: "ADMIN", says: "Settings, domains, deletes projects, manages developers" },
  { role: "OWNER", says: "Everything, including admins and owners" },
];

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

/** Teams you belong to, and their members. */
export default function TeamsPage() {
  const organizations = useApi<Organization[]>("/organizations");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const teams = (organizations.data ?? []).filter((org) => !org.personal);
  const selected = teams.find((org) => org.id === selectedId) ?? teams[0];

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const team = await api<Organization>("/organizations", { method: "POST", body: { name } });
      setName("");
      await organizations.reload();
      setSelectedId(team.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-12">
      <h1 className="font-display text-5xl font-bold uppercase">Organizations</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        An organization shares projects. Your personal projects stay yours; create an organization to work with others, then
        pick it when you create a project. Inside one, teams give groups more access to chosen projects.
      </p>

      <div className="mt-8 grid gap-10 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div>
          <ul className="flex flex-col gap-1" aria-label="Your organizations">
            {teams.map((team) => (
              <li key={team.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(team.id)}
                  aria-current={team.id === selected?.id ? "true" : undefined}
                  className={`w-full border-l-2 px-3 py-2 text-left text-sm ${
                    team.id === selected?.id ? "border-ink font-semibold" : "border-transparent text-ink-soft hover:text-ink"
                  }`}
                >
                  {team.name}
                  <span className="block text-xs text-ink-soft">
                    {team.role.toLowerCase()} · {team.members} member{team.members === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {organizations.data && teams.length === 0 && <p className="text-sm text-ink-soft">You&apos;re not in an organization yet.</p>}

          <form onSubmit={(event) => void create(event)} className="mt-6 flex flex-col gap-2 border-t border-rivet pt-4">
            <Label>New organization</Label>
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} placeholder="e.g. Acme" className={FIELD} />
            <Button type="submit" busy={busy}>
              Create organization
            </Button>
          </form>
          {error && (
            <div className="mt-4">
              <ErrorNote title="Couldn't create the organization">{error.message}</ErrorNote>
            </div>
          )}
        </div>

        {selected && (
          <div key={selected.id}>
            <Members team={selected} onChanged={() => void organizations.reload()} />
            <OrgTeams organization={selected} />
            {can(selected.role, "ADMIN") && <ServiceAccounts organization={selected} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Members({ team, onChanged }: { team: Organization; onChanged: () => void }) {
  const members = useApi<Member[]>(`/organizations/${team.id}/members`);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<OrgRole>("DEVELOPER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const manage = can(team.role, "ADMIN");
  // ADMINs manage developers and viewers; only OWNERs touch admins and owners.
  const grantable = ROLES.filter((r) => team.role === "OWNER" || !can(r.role, "ADMIN"));
  const owners = (members.data ?? []).filter((member) => member.role === "OWNER").length;
  // The API refuses to remove or demote the last owner; don't offer it.
  const editable = (member: Member) =>
    manage && grantable.some((r) => r.role === member.role) && !(member.role === "OWNER" && owners === 1);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await members.reload();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="members-heading">
      <h2 id="members-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
        {team.name}
      </h2>
      <ul className="mt-4 divide-y divide-rivet border-y border-rivet text-sm">
        {(members.data ?? []).map((member) => (
          <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="flex items-center gap-3">
              {member.avatarUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- remote avatar
                <img src={member.avatarUrl} alt="" width={28} height={28} className="size-7 rounded-full" />
              )}
              <span className="font-semibold">{member.login}</span>
            </span>
            <span className="flex items-center gap-4">
              {editable(member) ? (
                <select
                  aria-label={`Role of ${member.login}`}
                  value={member.role}
                  disabled={busy}
                  onChange={(event) =>
                    void act(() =>
                      api(`/organizations/${team.id}/members/${member.userId}`, { method: "PATCH", body: { role: event.target.value } }),
                    )
                  }
                  className="h-9 border border-rivet bg-plate px-2 text-sm"
                >
                  {grantable.map((r) => (
                    <option key={r.role} value={r.role}>
                      {r.role.toLowerCase()}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-ink-soft">{member.role.toLowerCase()}</span>
              )}
              {editable(member) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove ${member.login} from ${team.name}?`)) {
                      void act(() => api(`/organizations/${team.id}/members/${member.userId}`, { method: "DELETE" }));
                    }
                  }}
                  className="text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                >
                  Remove<span className="sr-only"> {member.login}</span>
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {manage && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api(`/organizations/${team.id}/members`, { method: "POST", body: { login, role } });
              setLogin("");
            });
          }}
          className="mt-6 flex flex-wrap items-end gap-3"
        >
          <label className="flex min-w-0 flex-1 flex-col gap-2">
            <Label>Add by GitHub login</Label>
            <input value={login} onChange={(event) => setLogin(event.target.value)} required maxLength={39} placeholder="octocat" className={FIELD} />
          </label>
          <label className="flex flex-col gap-2">
            <Label>Role</Label>
            <select value={role} onChange={(event) => setRole(event.target.value as OrgRole)} className={FIELD}>
              {grantable.map((r) => (
                <option key={r.role} value={r.role}>
                  {r.role.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" busy={busy}>
            Add member
          </Button>
        </form>
      )}
      <p className="mt-3 text-xs text-ink-soft">They must have signed in to this Shipyard once.</p>

      {error && (
        <div className="mt-4">
          <ErrorNote title="That didn't work">{error.message}</ErrorNote>
        </div>
      )}

      <dl className="mt-8 grid gap-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        {ROLES.map((r) => (
          <div key={r.role} className="contents">
            <dt className="font-semibold">{r.role.toLowerCase()}</dt>
            <dd className="text-ink-soft">{r.says}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
