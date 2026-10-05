import { PIPELINE, STAGE_LABEL, isInProgress, stageProgress } from "@/lib/status";
import type { Deployment } from "@/lib/types";

/**
 * The deployment pipeline drawn as draft marks on a bow: stages are numbered
 * bottom to top, and the waterline rises as the deployment gets through them.
 * Below the line = done. A failed stage is marked in oxide at the line.
 */
export function DraftScale({
  deployment,
}: {
  deployment: Pick<Deployment, "status" | "commitSha" | "containerId" | "failedStage">;
}) {
  const { reached, failedAt } = stageProgress(deployment);
  const working = isInProgress(deployment.status);
  const failed = failedAt !== null;
  const stopped = deployment.status === "STOPPED" || deployment.status === "STOPPING";
  const level = failed ? failedAt : reached; // the stage the waterline sits on
  const fill = ((level + 1) / PIPELINE.length) * 100;

  const water = failed ? "bg-oxide-wash" : stopped ? "bg-rivet/40" : "bg-sea-wash";
  const line = failed ? "border-oxide" : stopped ? "border-ink-soft" : "border-ink";

  return (
    // self-start: the scale must be exactly as tall as its rows, or the water's % height drifts.
    <div className="relative self-start border-l-2 border-ink">
      {/* The water. Its top edge is the waterline. */}
      <div
        aria-hidden
        className={`absolute inset-x-0 bottom-0 border-t-2 transition-[height] duration-700 ease-out ${water} ${line}`}
        style={{ height: `${fill}%` }}
      />
      <ol className="relative flex flex-col-reverse" aria-label="Deployment stages">
        {PIPELINE.map((stage, index) => {
          const isFailed = index === failedAt;
          const isCurrent = !failed && working && index === reached;
          const done = index <= reached;
          const state = isFailed ? "failed" : isCurrent ? "in progress" : done ? "done" : "not reached";
          return (
            <li
              key={stage}
              aria-current={isCurrent || isFailed ? "step" : undefined}
              className="flex h-12 items-center gap-4 pl-4"
            >
              {/* Draft marks: tall condensed numerals, read from the bottom up. */}
              <span
                aria-hidden
                className={`w-8 font-display text-3xl font-bold leading-none tabular-nums ${
                  isFailed ? "text-oxide" : done ? "text-ink" : "text-rivet"
                }`}
              >
                {index + 1}
              </span>
              <span className="flex flex-col">
                <span className={`text-sm font-semibold ${isFailed ? "text-oxide" : done ? "text-ink" : "text-ink-soft"}`}>
                  {STAGE_LABEL[stage]}
                </span>
                <span className="text-xs text-ink-soft">
                  {isFailed ? "Failed here" : isCurrent ? <span className="signal-pulse">In progress</span> : null}
                  <span className="sr-only">{state}</span>
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
