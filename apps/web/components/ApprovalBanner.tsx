"use client";

import { useState } from "react";

import { Button, ErrorNote } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { Approval } from "@/lib/types";
import { useApi } from "@/lib/useApi";

/** A production deploy waiting for an admin (organization policy): who may decide sees the buttons. */
export function ApprovalBanner({ deploymentId, canDecide, onDecided }: { deploymentId: string; canDecide: boolean; onDecided: () => void }) {
  const approval = useApi<Approval>(`/deployments/${deploymentId}/approval`, { pollMs: (a) => (a.status === "AWAITING" ? 5000 : null) });
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  if (approval.data?.status !== "AWAITING") {
    if (approval.data?.status === "APPROVED" || approval.data?.status === "REJECTED") {
      return (
        <p className="mt-4 text-sm text-ink-soft">
          {approval.data.status === "APPROVED" ? "Approved" : "Rejected"} by {approval.data.decidedBy ?? "an admin"}.
        </p>
      );
    }
    return null;
  }
  const decide = async (choice: "approve" | "reject") => {
    setBusy(choice);
    setError(null);
    try {
      await api(`/deployments/${deploymentId}/${choice}`, { method: "POST" });
      await approval.reload();
      onDecided();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-6 border-l-4 border-signal bg-plate px-4 py-3" role="status">
      <p className="font-semibold">Waiting for approval</p>
      <p className="mt-1 text-sm text-ink-soft">
        Your organization asks an admin to approve production deploys. It starts as soon as one does.
      </p>
      {canDecide && (
        <div className="mt-3 flex gap-3">
          <Button busy={busy === "approve"} disabled={busy !== null} onClick={() => void decide("approve")}>
            Approve and deploy
          </Button>
          <Button variant="secondary" busy={busy === "reject"} disabled={busy !== null} onClick={() => void decide("reject")}>
            Reject
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <ErrorNote title="That didn't work">{error.message}</ErrorNote>
        </div>
      )}
    </div>
  );
}
