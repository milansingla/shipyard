"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono, StatusBadge } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { safeHttpUrl } from "@/lib/format";
import type { ApiResource } from "@/lib/useApi";
import type { Deployment, Service, ServiceType } from "@/lib/types";

const FIELD = "h-10 border border-rivet bg-plate px-3 text-sm focus:border-ink";

interface Draft {
  name: string;
  type: ServiceType;
  sourceDir: string;
  port: string;
  isPublic: boolean;
  startCommand: string;
  buildCommand: string;
}

const EMPTY: Draft = { name: "", type: "WEB", sourceDir: ".", port: "", isPublic: false, startCommand: "", buildCommand: "" };

/** Where a service can be reached, in words a person can use. */
function address(service: Service): { text: string; href: string | null } {
  if (service.type === "WORKER") return { text: "Background worker, no address", href: null };
  if (!service.public) return { text: `http://${service.name}:${service.port ?? "<port>"} inside the project`, href: null };
  const url = safeHttpUrl(service.latestDeployment?.status === "RUNNING" ? service.latestDeployment.deploymentUrl : null);
  return { text: url ?? "Public once deployed", href: url };
}

/**
 * The parts of a project. Each builds from a directory of the repository and
 * runs as its own container; services reach each other by name.
 */
export function ServicesPanel({
  projectId,
  services,
  canDeploy,
  canEdit,
  onDeployed,
}: {
  projectId: string;
  services: ApiResource<Service[]>;
  canDeploy: boolean;
  canEdit: boolean;
  onDeployed: (deployment: Deployment) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await services.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(null);
    }
  }

  const add = (event: FormEvent) => {
    event.preventDefault();
    void act("add", async () => {
      await api(`/projects/${projectId}/services`, {
        method: "POST",
        body: {
          name: draft.name.trim(),
          type: draft.type,
          sourceDir: draft.sourceDir.trim() || ".",
          ...(draft.type === "WEB" && { public: draft.isPublic, ...(draft.port && { port: Number(draft.port) }) }),
          ...(draft.startCommand.trim() && { startCommand: draft.startCommand.trim() }),
          ...(draft.buildCommand.trim() && { buildCommand: draft.buildCommand.trim() }),
        },
      });
      setDraft(EMPTY);
      setAdding(false);
    });
  };

  const list = services.data ?? [];

  return (
    <section className="mt-12" aria-labelledby="services-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="services-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
          Services
        </h2>
        <p className="text-sm text-ink-soft">Services reach each other by name, like http://api:4000.</p>
      </div>

      <ul className="mt-4 divide-y divide-rivet border-y border-rivet text-sm">
        {list.map((service) => {
          const where = address(service);
          return (
            <li key={service.id} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <span className="font-semibold">{service.name}</span>
                <span className="ml-2 rounded-sm border border-rivet px-1.5 py-0.5 text-xs text-ink-soft">
                  {service.type === "WORKER" ? "worker" : service.public ? "public" : "private"}
                </span>
                <p className="mt-1 truncate text-xs text-ink-soft">
                  <Mono>{service.sourceDir === "." ? "repository root" : service.sourceDir}</Mono>
                </p>
              </div>
              <div className="min-w-0">
                {service.latestDeployment ? (
                  <Link href={`/deployments/${service.latestDeployment.id}`} className="inline-flex">
                    <StatusBadge status={service.latestDeployment.status} />
                  </Link>
                ) : (
                  <span className="text-ink-soft">Never deployed</span>
                )}
                <p className="mt-1 break-all text-xs">
                  {where.href ? (
                    <a href={where.href} target="_blank" rel="noreferrer" className="font-mono underline decoration-rivet underline-offset-4">
                      {where.text}
                    </a>
                  ) : (
                    <span className="text-ink-soft">{where.text}</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {canDeploy && (
                  <Button
                    variant="secondary"
                    busy={busy === `deploy:${service.id}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void act(`deploy:${service.id}`, async () => {
                        onDeployed(await api<Deployment>(`/services/${service.id}/deploy`, { method: "POST" }));
                      })
                    }
                  >
                    Deploy
                  </Button>
                )}
                {canEdit && list.length > 1 && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(`Delete the ${service.name} service? Its containers, images and its own variables are removed.`)) {
                        void act(`delete:${service.id}`, () => api(`/services/${service.id}`, { method: "DELETE" }));
                      }
                    }}
                    className="text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                  >
                    Delete<span className="sr-only"> {service.name}</span>
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {canEdit && !adding && (
        <div className="mt-4">
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add a service
          </Button>
        </div>
      )}

      {canEdit && adding && (
        <form onSubmit={add} className="mt-6 grid gap-4 border-t border-rivet pt-6 sm:grid-cols-3">
          <label className="flex flex-col gap-2">
            <Label>Name</Label>
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
              maxLength={20}
              placeholder="api"
              className={`${FIELD} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-2">
            <Label>Kind</Label>
            <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as ServiceType })} className={FIELD}>
              <option value="WEB">Web: serves HTTP</option>
              <option value="WORKER">Worker: runs in the background</option>
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <Label>Directory</Label>
            <input
              value={draft.sourceDir}
              onChange={(event) => setDraft({ ...draft, sourceDir: event.target.value })}
              placeholder="apps/api"
              className={`${FIELD} font-mono`}
            />
          </label>
          {draft.type === "WEB" && (
            <>
              <label className="flex flex-col gap-2">
                <Label>Port</Label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(event) => setDraft({ ...draft, port: event.target.value })}
                  placeholder="Detected"
                  className={FIELD}
                />
              </label>
              <label className="flex items-center gap-3 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={draft.isPublic}
                  onChange={(event) => setDraft({ ...draft, isPublic: event.target.checked })}
                  className="size-4 accent-ink"
                />
                <span>
                  <span className="font-semibold">Public</span>
                  <span className="block text-ink-soft">Gets its own address. Otherwise only the project&apos;s other services can reach it.</span>
                </span>
              </label>
            </>
          )}
          <label className="flex flex-col gap-2 sm:col-span-3">
            <Label>Start command</Label>
            <input
              value={draft.startCommand}
              onChange={(event) => setDraft({ ...draft, startCommand: event.target.value })}
              placeholder="Detected (e.g. npm start)"
              className={`${FIELD} font-mono`}
            />
          </label>
          <div className="flex gap-3 sm:col-span-3">
            <Button type="submit" busy={busy === "add"}>
              Add service
            </Button>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
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
