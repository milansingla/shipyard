"use client";

import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Label } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

interface Proposal {
  action: "rollback" | "redeploy" | "restart" | "stop";
  label: string;
  method: "POST";
  path: string;
  reason: string;
}

interface Exchange {
  question: string;
  answer: string;
  proposals: Proposal[];
}

const FIELD = "border border-rivet bg-plate px-3 py-2 text-sm focus:border-ink";

/**
 * Questions about your projects in plain language. The assistant sees only
 * what you can see and changes nothing: a change it suggests is a button
 * you press, which runs the normal action with your permissions.
 */
export default function AssistantPage() {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  async function attempt(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(null);
    }
  }

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const asked = question.trim();
    if (!asked) return;
    void attempt("ask", async () => {
      const reply = await api<{ answer: string; proposals: Proposal[] }>("/ai/ask", { method: "POST", body: { question: asked } });
      setHistory((previous) => [{ question: asked, ...reply }, ...previous]);
      setQuestion("");
    });
  };

  const run = (proposal: Proposal) => {
    if (!window.confirm(`${proposal.label}?\n\n${proposal.reason}`)) return;
    void attempt(proposal.path, async () => {
      await api(proposal.path, { method: proposal.method });
      setDone((previous) => ({ ...previous, [proposal.path]: "Started." }));
    });
  };

  return (
    <div className="pt-2">
      <h1 className="page-title">Assistant</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Ask about your projects: why a deploy failed, what is unhealthy, what changed. It reads only what you can see, and never changes
        anything itself; if it suggests an action, you decide whether to run it.
      </p>

      <form onSubmit={ask} className="panel mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-2">
          <Label>Question</Label>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Why did my last deployment of shop fail?"
            className={FIELD}
          />
        </label>
        <div>
          <Button type="submit" busy={busy === "ask"} disabled={question.trim().length < 3}>
            Ask
          </Button>
        </div>
      </form>

      {error && (
        <div className="mt-4">
          <ErrorNote title="That didn't work">{error.message}</ErrorNote>
        </div>
      )}

      <ol className="mt-10 space-y-8">
        {history.map((exchange, index) => (
          <li key={history.length - index} className="panel">
            <p className="font-semibold">{exchange.question}</p>
            <p className="mt-3 whitespace-pre-wrap text-sm">{exchange.answer}</p>
            {exchange.proposals.length > 0 && (
              <div className="mt-4 space-y-2">
                <Label>Suggested actions</Label>
                {exchange.proposals.map((proposal) => (
                  <div key={proposal.path} className="flex flex-wrap items-center gap-3 text-sm">
                    <Button
                      variant="secondary"
                      busy={busy === proposal.path}
                      disabled={busy !== null || proposal.path in done}
                      onClick={() => run(proposal)}
                    >
                      {proposal.label}
                    </Button>
                    <span className="text-ink-soft">{done[proposal.path] ?? proposal.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
