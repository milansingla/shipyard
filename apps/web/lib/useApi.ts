"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "./api";
import { useSession } from "./session";

interface Options<T> {
  /** Poll interval in ms while it returns a number; null stops polling (e.g. once a deploy finishes). */
  pollMs?: (data: T) => number | null;
}

export interface ApiResource<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * GET a resource, optionally polling it. A 401 at any point means the session
 * ended, so the whole app falls back to the sign-in screen.
 */
export function useApi<T>(path: string | null, options: Options<T> = {}): ApiResource<T> {
  const { signedOut } = useSession();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const pollRef = useRef(options.pollMs);
  pollRef.current = options.pollMs;
  const dataRef = useRef<T>(undefined);

  const load = useCallback(async () => {
    if (path === null) return;
    try {
      const next = await api<T>(path);
      dataRef.current = next;
      setData(next);
      setError(null);
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught));
      if (failure.isSignedOut) signedOut();
      setError(failure);
    } finally {
      setLoading(false);
    }
  }, [path, signedOut]);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      await load();
      if (cancelled) return;
      // A failed poll keeps the last good data and keeps polling: blips shouldn't freeze the page.
      const current = dataRef.current;
      const interval = current === undefined ? null : pollRef.current?.(current);
      if (interval != null) timer = setTimeout(() => void tick(), interval);
    };
    setLoading(true);
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, load]);

  return { data, error, loading, reload: load };
}
