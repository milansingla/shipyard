"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label, Mono, StatusBadge } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { safeHttpUrl } from "@/lib/format";
import type { ApiResource } from "@/lib/useApi";
import type { Deployment, Service, ServiceType, Volume } from "@/lib/types";

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

/**
 * Asks before something whose data would be deleted for good. With volumes,
 * a click isn't enough: the name has to be typed. Returns the query to send.
 */
export function confirmDeletion(what: string, name: string, volumes: Volume[], removes: string): string | null {
  if (volumes.length === 0) return window.confirm(`Delete ${what}? ${removes}`) ? "" : null;
  const typed = window.prompt(
    `Delete ${what} AND the data in its volumes (${volumes.map((v) => v.name).join(", ")})? ${removes} The stored files are deleted for good.\n\nType ${name} to confirm.`,
  );
  if (typed === null) return null;
  if (typed.trim() !== name) {
    window.alert(`Nothing was deleted: that wasn't "${name}".`);
    return null;
  }
  return "?deleteData=true";
}

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
  /** The service whose "add a volume" form is open. */
  const [volumeFor, setVolumeFor] = useState<string | null>(null);
  const [volumeDraft, setVolumeDraft] = useState({ name: "", mountPath: "" });

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

  const addVolume = (event: FormEvent, serviceId: string) => {
    event.preventDefault();
    void act(`volume:${serviceId}`, async () => {
      await api(`/services/${serviceId}/volumes`, {
        method: "POST",
        body: { name: volumeDraft.name.trim(), mountPath: volumeDraft.mountPath.trim() },
      });
      setVolumeDraft({ name: "", mountPath: "" });
      setVolumeFor(null);
    });
  };

  const detach = (service: Service, volume: Volume) => {
    if (
      !window.confirm(
        `Stop mounting ${volume.name} into ${service.name}? The next deployment won't see these files. They stay on the server: adding a volume named ${volume.name} again brings them back.`,
      )
    ) {
      return;
    }
    void act(`detach:${volume.id}`, () => api(`/volumes/${volume.id}`, { method: "DELETE" }));
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
                {service.managedBy === "CONFIG_FILE" && (
                  <span
                    className="ml-1 rounded-sm border border-rivet px-1.5 py-0.5 text-xs text-ink-soft"
                    title={
                      service.overrides.length
                        ? `Changed here, so the file no longer sets: ${service.overrides.join(", ")}`
                        : "Settings come from the repository's shipyard.yaml"
                    }
                  >
                    shipyard.yaml
                  </span>
                )}
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
                      const query = confirmDeletion(
                        `the ${service.name} service`,
                        service.name,
                        service.volumes,
                        "Its containers, images and its own variables are removed.",
                      );
                      if (query !== null) {
                        void act(`delete:${service.id}`, () => api(`/services/${service.id}${query}`, { method: "DELETE" }));
                      }
                    }}
                    className="text-sm text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                  >
                    Delete<span className="sr-only"> {service.name}</span>
                  </button>
                )}
              </div>

              {(service.volumes.length > 0 || canEdit) && (
                <div className="sm:col-span-3">
                  {service.volumes.length > 0 && (
                    <ul className="flex flex-wrap gap-2" aria-label={`Volumes of ${service.name}`}>
                      {service.volumes.map((volume) => (
                        <li key={volume.id} className="flex items-center gap-2 border border-rivet bg-primer px-2 py-1 text-xs">
                          <span className="font-semibold">{volume.name}</span>
                          <Mono className="text-ink-soft">{volume.mountPath}</Mono>
                          {canEdit && (
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => detach(service, volume)}
                              className="text-oxide underline decoration-rivet underline-offset-4 hover:decoration-oxide"
                            >
                              Detach<span className="sr-only"> {volume.name}</span>
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canEdit && volumeFor !== service.id && (
                    <button
                      type="button"
                      onClick={() => {
                        setVolumeFor(service.id);
                        setVolumeDraft({ name: "", mountPath: "" });
                      }}
                      className={`${service.volumes.length > 0 ? "mt-2 " : ""}text-xs underline decoration-rivet underline-offset-4 hover:decoration-ink`}
                    >
                      Add a volume<span className="sr-only"> to {service.name}</span>
                    </button>
                  )}
                  {canEdit && volumeFor === service.id && (
                    <form onSubmit={(event) => addVolume(event, service.id)} className="mt-2 flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1">
                        <Label>Volume name</Label>
                        <input
                          value={volumeDraft.name}
                          onChange={(event) => setVolumeDraft({ ...volumeDraft, name: event.target.value })}
                          required
                          maxLength={30}
                          placeholder="uploads"
                          autoComplete="off"
                          spellCheck={false}
                          className={`${FIELD} w-40 font-mono`}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <Label>Mounted at</Label>
                        <input
                          value={volumeDraft.mountPath}
                          onChange={(event) => setVolumeDraft({ ...volumeDraft, mountPath: event.target.value })}
                          required
                          maxLength={200}
                          placeholder="/app/uploads"
                          autoComplete="off"
                          spellCheck={false}
                          className={`${FIELD} w-56 font-mono`}
                        />
                      </label>
                      <Button type="submit" busy={busy === `volume:${service.id}`}>
                        Add volume
                      </Button>
                      <Button variant="secondary" onClick={() => setVolumeFor(null)}>
                        Cancel
                      </Button>
                      <p className="w-full text-xs text-ink-soft">
                        Files the app writes there are kept across deployments. Mounted from the next deploy on.
                      </p>
                    </form>
                  )}
                </div>
              )}
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
