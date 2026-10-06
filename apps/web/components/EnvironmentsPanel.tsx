"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono, StatusBadge } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { relativeTime, safeHttpUrl } from "@/lib/format";
import type { Deployment, ProjectEnvironment, Service } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

/**
 * Production is the project itself; a development environment runs another
 * branch next to it, and each pull request can get a preview. They run the
 * web services and workers, never the databases, volumes or production secrets.
 */
export function EnvironmentsPanel({
  projectId,
  productionBranch,
  services,
  canEdit,
  canDeploy,
  onDeployed,
}: {
  projectId: string;
  productionBranch: string;
  services: Service[];
  canEdit: boolean;
  canDeploy: boolean;
  onDeployed: (deployment: Deployment) => void;
}) {
  const environments = useApi<ProjectEnvironment[]>(`/projects/${projectId}/environments`, {
    pollMs: (list) =>
      list.some((environment) => environment.deployments.some((d) => !["RUNNING", "FAILED", "STOPPED"].includes(d.status))) ? 3000 : null,
  });
  const [branch, setBranch] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const primary = services.find((service) => service.primary);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await environments.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(null);
    }
  }

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (branch === null) return;
    void act("create", async () => {
      await api(`/projects/${projectId}/environments`, { method: "POST", body: { type: "DEVELOPMENT", branch: branch.trim() } });
      setBranch(null);
    });
  };

  const list = environments.data ?? [];
  const active = list.filter((environment) => environment.status === "ACTIVE");
  const closed = list.filter((environment) => environment.status === "CLOSED");
  const hasDevelopment = active.some((environment) => environment.type === "DEVELOPMENT");

  return (
    <section className="mt-12" aria-labelledby="environments-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="environments-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
          Environments
        </h2>
        <p className="text-sm text-ink-soft">
          Production deploys <Mono>{productionBranch}</Mono>.
        </p>
      </div>

      {environments.error && (
        <div className="mt-4">
          <ErrorNote title="Couldn't load environments">{environments.error.message}</ErrorNote>
        </div>
      )}

      {environments.data && active.length === 0 && (
        <p className="mt-4 text-ink-soft">
          Only production so far. A development environment runs another branch, like <Mono>develop</Mono>, at its own address.
        </p>
      )}

      {active.length > 0 && (
        <ul className="mt-4 divide-y divide-rivet border-y border-rivet text-sm">
          {active.map((environment) => {
            const shown = environment.deployments.find((d) => d.serviceId === primary?.id) ?? environment.deployments[0];
            const url = safeHttpUrl(shown?.status === "RUNNING" ? shown.deploymentUrl : null);
            return (
              <li key={environment.id} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <span className="font-semibold">{environment.type === "DEVELOPMENT" ? "Development" : `Preview #${environment.pullRequest}`}</span>
                  <p className="mt-1 truncate text-xs text-ink-soft">
                    <Mono>{environment.branch}</Mono>
                    {environment.title && ` · ${environment.title}`}
                  </p>
                </div>
                <div className="min-w-0">
                  {shown ? (
                    <Link href={`/deployments/${shown.id}`} className="inline-flex">
                      <StatusBadge status={shown.status} />
                    </Link>
                  ) : (
                    <span className="text-ink-soft">Never deployed</span>
                  )}
                  <p className="mt-1 break-all text-xs">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" className="font-mono underline decoration-rivet underline-offset-4">
                        {url}
                      </a>
                    ) : (
                      <span className="text-ink-soft">{shown ? `Updated ${relativeTime(shown.createdAt)}` : "Deploy it to get an address"}</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {canDeploy && (
                    <Button
                      variant="secondary"
                      busy={busy === `deploy:${environment.id}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void act(`deploy:${environment.id}`, async () => {
                          onDeployed(await api<Deployment>(`/environments/${environment.id}/deploy`, { method: "POST" }));
                        })
                      }
                    >
                      Deploy
                    </Button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        if (window.confirm(`Take ${environment.name} down? Its containers and images are removed; its history stays.`)) {
                          void act(`close:${environment.id}`, () => api(`/environments/${environment.id}/close`, { method: "POST" }));
                        }
                      }}
                      className="text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                    >
                      Close<span className="sr-only"> {environment.name}</span>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {closed.length > 0 && (
        <p className="mt-3 text-xs text-ink-soft">
          Closed: {closed.map((environment) => (environment.pullRequest ? `#${environment.pullRequest}` : environment.name)).join(", ")}
        </p>
      )}

      {canEdit && !hasDevelopment && branch === null && (
        <div className="mt-4">
          <Button variant="secondary" onClick={() => setBranch("develop")}>
            Add a development environment
          </Button>
        </div>
      )}

      {canEdit && branch !== null && (
        <form onSubmit={create} className="mt-6 flex flex-wrap items-end gap-3 border-t border-rivet pt-6">
          <label className="flex flex-col gap-2">
            <Label>Branch</Label>
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              required
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD} w-56 font-mono`}
            />
          </label>
          <Button type="submit" busy={busy === "create"}>
            Add environment
          </Button>
          <Button variant="secondary" onClick={() => setBranch(null)}>
            Cancel
          </Button>
          <p className="w-full text-xs text-ink-soft">
            Pushes to this branch deploy it at <Mono>dev-…</Mono> addresses. It gets variables set for All or Development, and
            uses production&apos;s databases through their URLs; it never runs its own.
          </p>
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
