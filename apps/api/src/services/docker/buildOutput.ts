/** One JSON message from Docker's /build progress stream. */
export interface BuildEvent {
  stream?: string;
  status?: string;
  /** Layer id for image-pull status messages. */
  id?: string;
  /** Byte-level pull progress; present (with `current`) on very frequent events. */
  progressDetail?: { current?: number; total?: number };
  error?: string;
  errorDetail?: { code?: number; message?: string };
  aux?: unknown;
}

export interface InterpretedBuildEvent {
  log?: string;
  error?: string;
}

/**
 * IMPORTANT: Docker reports a failed build (bad RUN step, missing file, …) as a
 * normal progress event carrying `error`/`errorDetail` — NOT as a stream error.
 * V0.1 only listened for stream errors, so failed builds looked successful.
 */
export function interpretBuildEvent(event: BuildEvent): InterpretedBuildEvent {
  const error = event.errorDetail?.message ?? event.error;
  if (error) return { error: error.trim() };

  if (event.stream) return { log: event.stream };

  // Image pulls (FROM node:…) emit one "Downloading"/"Extracting" event per
  // chunk per layer. Keep the milestones ("Pulling fs layer", "Pull complete"),
  // drop the byte-level progress.
  if (event.status && event.progressDetail?.current === undefined) {
    return { log: `${event.id ? `${event.id}: ` : ""}${event.status}\n` };
  }

  return {};
}
