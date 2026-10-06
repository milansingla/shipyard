import { statfsSync } from "node:fs";

/** Free space on the filesystem holding `path`, in percent; undefined if it can't be read. */
export function diskFreePercent(path: string): number | undefined {
  try {
    const stats = statfsSync(path);
    return stats.blocks > 0 ? Math.round((stats.bavail / stats.blocks) * 1000) / 10 : undefined;
  } catch {
    return undefined;
  }
}
