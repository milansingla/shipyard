/**
 * Which worker should run a deploy job. Deliberately simple: among ONLINE
 * workers that accept jobs and have a free slot (and enough memory for the
 * job's largest container), the one with the most free slots, then the most
 * memory, then the most CPUs. DRAINING and OFFLINE workers never get work.
 */

export interface SchedulableWorker {
  id: string;
  name: string;
  status: "ONLINE" | "DRAINING" | "OFFLINE";
  acceptsJobs: boolean;
  cpus: number;
  memoryMb: number;
  runningJobs: number;
}

export interface JobNeeds {
  /** The largest memory limit among the job's services, if any. */
  memoryMb: number | null;
}

/** Jobs a worker runs at once. */
export const JOB_SLOTS_PER_WORKER = 2;

export function eligibleWorkers(workers: readonly SchedulableWorker[], needs: JobNeeds): SchedulableWorker[] {
  return workers.filter(
    (worker) =>
      worker.status === "ONLINE" &&
      worker.acceptsJobs &&
      worker.runningJobs < JOB_SLOTS_PER_WORKER &&
      (needs.memoryMb === null || worker.memoryMb >= needs.memoryMb),
  );
}

export function pickWorker(workers: readonly SchedulableWorker[], needs: JobNeeds): SchedulableWorker | null {
  const ranked = eligibleWorkers(workers, needs).sort(
    (a, b) =>
      b.runningJobs === a.runningJobs
        ? b.memoryMb - a.memoryMb || b.cpus - a.cpus || a.name.localeCompare(b.name)
        : a.runningJobs - b.runningJobs,
  );
  return ranked[0] ?? null;
}
