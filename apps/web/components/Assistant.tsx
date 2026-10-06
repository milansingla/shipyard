"use client";

import { type ReactNode, useState } from "react";

import { Button, ErrorNote, Label, Mono } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

interface Diagnosis {
  summary: string;
  cause: string;
  category: string;
  evidence: string[];
  droppedEvidence: number;
  suggestedFix: string;
  confidence: number;
  rollback: { recommended: boolean; targetId: string | null; reason: string };
}

interface Analysis {
  suggestion: {
    language: string;
    framework: string | null;
    packageManager: string | null;
    buildCommand: string | null;
    startCommand: string | null;
    port: number | null;
    healthEndpoint: string | null;
    nodeVersion: string | null;
    evidence: Array<{ file: string; excerpt: string; supports: string }>;
    confidence: number;
    notes: string;
  };
  droppedEvidence: number;
  disagreements: string[];
  note: string;
}

interface DockerfileSuggestion {
  dockerfile: string;
  explanation: string;
  problems: string[];
  warnings: string[];
  usable: boolean;
  note: string;
}

interface IncidentSummary {
  summary: string;
  likelyCause: string;
  remediation: string[];
  confidence: number;
  timeline: Array<{ at: string; event: string }>;
}

/** Runs one assistant request; the API's message (e.g. "isn't configured") is shown as-is. */
function useAssistant<T>() {
  const [result, setResult] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<T>(path, { method: "POST", body }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(false);
    }
  };
  return { result, busy, error, run, setResult };
}

function Confidence({ value }: { value: number }) {
  const label = value >= 0.75 ? "high" : value >= 0.4 ? "medium" : "low";
  return (
    <span className="text-xs text-ink-soft">
      Confidence: {label} ({Math.round(value * 100)}%)
    </span>
  );
}

function Quotes({ items }: { items: ReactNode[] }) {
  if (items.length === 0) return <p className="text-sm text-ink-soft">No log line backs this up; treat it as a guess.</p>;
  return (
    <ul className="space-y-1">
      {items.map((item, index) => (
        <li key={index} className="overflow-x-auto bg-ink px-3 py-1.5 font-mono text-xs text-plate">
          {item}
        </li>
      ))}
    </ul>
  );
}

function AssistantBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 border-l-2 border-ink pl-4" aria-label={title}>
      <Label>{title}</Label>
      <div className="mt-2 space-y-3 text-sm">{children}</div>
    </section>
  );
}

/** "Why did this fail?": the assistant's reading of the logs, with the lines it is based on. */
export function DiagnosePanel({ deploymentId, onRollBack }: { deploymentId: string; onRollBack: (() => void) | null }) {
  const { result, busy, error, run } = useAssistant<Diagnosis>();
  return (
    <div className="mt-8">
      {!result && (
        <Button variant="secondary" busy={busy} onClick={() => void run(`/ai/deployments/${deploymentId}/diagnosis`)}>
          Explain with the assistant
        </Button>
      )}
      {error && (
        <div className="mt-3">
          <ErrorNote title="The assistant couldn't answer">{error.message}</ErrorNote>
        </div>
      )}
      {result && (
        <AssistantBox title="Assistant's diagnosis">
          <p className="font-semibold">{result.summary}</p>
          <p>
            <span className="text-ink-soft">Cause ({result.category.replace("_", " ")}):</span> {result.cause}
          </p>
          <Quotes items={result.evidence} />
          <p>
            <span className="text-ink-soft">Try:</span> {result.suggestedFix}
          </p>
          <p className={result.rollback.recommended ? "font-semibold text-oxide" : "text-ink-soft"}>{result.rollback.reason}</p>
          {result.rollback.recommended && onRollBack && (
            <Button variant="secondary" onClick={onRollBack}>
              Roll back
            </Button>
          )}
          <Confidence value={result.confidence} />
        </AssistantBox>
      )}
    </div>
  );
}

/** Repository analysis and Dockerfile help: advice to review, never applied or deployed by itself. */
export function RepositoryAdvisor({ projectId, canSuggestDockerfile }: { projectId: string; canSuggestDockerfile: boolean }) {
  const analysis = useAssistant<Analysis>();
  const dockerfile = useAssistant<DockerfileSuggestion>();
  const s = analysis.result?.suggestion;
  return (
    <section className="mt-12" aria-labelledby="assistant-heading">
      <h2 id="assistant-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
        Assistant
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        Reads your repository and suggests how to run it. It changes nothing; you decide what to apply.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="secondary" busy={analysis.busy} onClick={() => void analysis.run(`/ai/projects/${projectId}/analysis`)}>
          Analyze repository
        </Button>
        {canSuggestDockerfile && (
          <Button variant="secondary" busy={dockerfile.busy} onClick={() => void dockerfile.run(`/ai/projects/${projectId}/dockerfile`)}>
            Suggest a Dockerfile
          </Button>
        )}
      </div>
      {(analysis.error ?? dockerfile.error) && (
        <div className="mt-3">
          <ErrorNote title="The assistant couldn't answer">{(analysis.error ?? dockerfile.error)!.message}</ErrorNote>
        </div>
      )}
      {analysis.result && s && (
        <AssistantBox title="Suggested settings">
          <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1">
            {(
              [
                ["Language", s.language],
                ["Framework", s.framework],
                ["Package manager", s.packageManager],
                ["Build command", s.buildCommand],
                ["Start command", s.startCommand],
                ["Port", s.port],
                ["Health endpoint", s.healthEndpoint],
                ["Node version", s.nodeVersion],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-soft">{label}</dt>
                <dd>{value === null ? <span className="text-ink-soft">unknown</span> : <Mono>{String(value)}</Mono>}</dd>
              </div>
            ))}
          </dl>
          <Quotes items={s.evidence.map((e) => `${e.file}: ${e.excerpt}  (${e.supports})`)} />
          {analysis.result.disagreements.map((line) => (
            <p key={line} className="text-oxide">
              Differs from Shipyard&apos;s detection: {line}
            </p>
          ))}
          {s.notes && <p>{s.notes}</p>}
          <p className="text-xs text-ink-soft">{analysis.result.note}</p>
          <Confidence value={s.confidence} />
        </AssistantBox>
      )}
      {dockerfile.result && (
        <AssistantBox title="Suggested Dockerfile">
          {dockerfile.result.problems.map((p) => (
            <p key={p} className="font-semibold text-oxide">
              Problem: {p}
            </p>
          ))}
          {dockerfile.result.warnings.map((w) => (
            <p key={w} className="text-ink-soft">
              Warning: {w}
            </p>
          ))}
          <pre className="max-h-96 overflow-auto bg-ink p-3 font-mono text-xs text-plate">{dockerfile.result.dockerfile}</pre>
          <p>{dockerfile.result.explanation}</p>
          <p className="text-xs text-ink-soft">{dockerfile.result.note}</p>
        </AssistantBox>
      )}
    </section>
  );
}

/** An incident in a paragraph: Shipyard's own timeline, and the assistant's reading of it. */
export function IncidentSummaryButton({ alertId }: { alertId: string }) {
  const { result, busy, error, run } = useAssistant<IncidentSummary>();
  if (!result) {
    return (
      <span className="block">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(`/ai/alerts/${alertId}/summary`)}
          className="text-xs underline decoration-rivet underline-offset-4 hover:decoration-ink"
        >
          {busy ? "Summarizing…" : "Summarize with the assistant"}
        </button>
        {error && <span className="block text-xs text-oxide">{error.message}</span>}
      </span>
    );
  }
  return (
    <AssistantBox title="Incident summary">
      <p className="font-semibold">{result.summary}</p>
      <p>
        <span className="text-ink-soft">Likely cause:</span> {result.likelyCause}
      </p>
      {result.remediation.length > 0 && (
        <ul className="list-disc pl-5">
          {result.remediation.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      )}
      <ol className="space-y-0.5 font-mono text-xs text-ink-soft">
        {result.timeline.map((t, index) => (
          <li key={index}>
            {new Date(t.at).toLocaleTimeString()} {t.event}
          </li>
        ))}
      </ol>
      <Confidence value={result.confidence} />
    </AssistantBox>
  );
}
