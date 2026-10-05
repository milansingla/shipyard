export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

/** First 7 hex characters of a UUID: enough to tell deployments apart at a glance, like a short SHA. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 7);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "just now", "5 minutes ago", "2 days ago". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  }
  return format.format(-Math.round(seconds / 60), "minute");
}

/** "48s", "3m 05s", "1h 02m". */
export function duration(startIso: string | null, endIso: string | null, now: Date = new Date()): string {
  if (!startIso) return "—";
  const total = Math.max(0, Math.round(((endIso ? new Date(endIso) : now).getTime() - new Date(startIso).getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Only http(s) URLs become links. Anything else — `javascript:` in particular —
 * is shown as text, never put in an href.
 */
export function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
