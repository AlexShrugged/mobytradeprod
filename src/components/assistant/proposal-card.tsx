"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { useAssistantRefresh } from "@/components/assistant/refresh-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/money";
import type {
  AgentProposalView,
  AlertDecisionPayload,
  AnalyzeEntryPayload,
} from "@/lib/agent/types";

// One propose-and-confirm card. Confirm executes through the EXISTING
// decision routes - PATCH /api/alerts/:id per unit id (the agent's note
// lands as resolutionNote), POST /api/entries/:id/analyze, or POST
// /api/org-rules (the same write path the Data page uses) - then records
// the outcome on the proposal. The card itself never writes domain data.

const DECISION_LABEL: Record<AlertDecisionPayload["decision"], string> = {
  resolved: "Accept",
  dismissed: "Dismiss",
  open: "Reopen",
};

async function recordProposal(
  proposalId: string,
  status: "confirmed" | "dismissed",
  results: { id: string; ok: boolean }[] | null,
) {
  const res = await fetch(`/api/agent/proposals/${proposalId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, results }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? "Failed to update the proposal.");
  }
}

export function ProposalCard({ proposal }: { proposal: AgentProposalView }) {
  const refresh = useAssistantRefresh();
  const [busy, setBusy] = React.useState(false);

  const payload = proposal.payload;
  const isDecision = payload.kind === "alert_decision";
  // A unit row decided outside this card makes the proposal stale - the
  // decision routes would still accept it, but the card should not invite
  // a blind overwrite.
  const stale = React.useMemo(() => {
    if (!isDecision || proposal.status !== "proposed") return false;
    if (proposal.liveStatuses === null) return false;
    const p = payload as AlertDecisionPayload;
    const live = p.unitIds
      .map((id) => proposal.liveStatuses?.[id])
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    if (live.length === 0) return false;
    // Reopen is moot once every row is open again; a decide is stale as
    // soon as any row was decided elsewhere.
    return p.decision === "open"
      ? live.every((s) => s === "open")
      : live.some((s) => s !== "open");
  }, [isDecision, payload, proposal.liveStatuses, proposal.status]);

  async function confirm() {
    setBusy(true);
    try {
      if (payload.kind === "alert_decision") {
        const results = await Promise.all(
          payload.unitIds.map(async (id) => {
            const res = await fetch(`/api/alerts/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                payload.decision === "open"
                  ? { status: "open" }
                  : { status: payload.decision, resolutionNote: payload.note },
              ),
            });
            return { id, ok: res.ok };
          }),
        );
        await recordProposal(proposal.id, "confirmed", results);
        toast.success(
          results.every((r) => r.ok)
            ? "Variance updated."
            : "Some rows failed to update.",
          { richColors: results.every((r) => r.ok) },
        );
      } else if (payload.kind === "save_org_rule") {
        const res = await fetch("/api/org-rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: payload.text,
            suppression: payload.suppression,
            source: "assistant",
          }),
        });
        const body = await res.json().catch(() => null);
        await recordProposal(proposal.id, "confirmed", [
          { id: "org-rule", ok: res.ok },
        ]);
        if (res.ok) {
          const cleared: number = body?.reaudit?.cleared ?? 0;
          toast.success(
            cleared > 0
              ? `Rule saved. ${cleared} alert${cleared === 1 ? "" : "s"} cleared.`
              : "Rule saved.",
          );
        } else {
          toast.error(body?.error ?? "Saving the rule failed.");
        }
      } else {
        const analyze = payload as AnalyzeEntryPayload;
        const res = await fetch(`/api/entries/${analyze.entryId}/analyze`, {
          method: "POST",
        });
        const ok = res.ok;
        await recordProposal(proposal.id, "confirmed", [
          { id: analyze.entryId, ok },
        ]);
        if (ok) {
          toast.success(`Analysis finished for entry ${analyze.entryNumber}.`);
        } else {
          const body = await res.json().catch(() => null);
          toast.error(body?.error ?? "Analysis failed.");
        }
      }
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Confirm failed.");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await recordProposal(proposal.id, "dismissed", null);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Decline failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Container query, not viewport: in the narrow widget panel the note
    // spans the full card width below the buttons; on the wide /assistant
    // page it keeps to the left column beside them.
    <div className="@container rounded-md border bg-card px-4 py-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
          {payload.kind === "alert_decision" ? (
            <>
              <span className="font-medium">
                {DECISION_LABEL[payload.decision]}
              </span>
              <Link
                href={payload.href}
                className="truncate font-medium text-blue-700 underline underline-offset-2 dark:text-blue-400"
              >
                {payload.label}
              </Link>
              <span className="text-muted-foreground">
                entry {payload.entryNumber}
              </span>
              {payload.impactCents !== null ? (
                <Money cents={payload.impactCents} />
              ) : null}
              {payload.unitIds.length > 1 ? (
                <span className="text-xs text-muted-foreground">
                  {payload.unitIds.length} rows
                </span>
              ) : null}
            </>
          ) : payload.kind === "save_org_rule" ? (
            <>
              <span className="font-medium">Save rule</span>
              {payload.suppression ? (
                <Badge variant="outline" className="font-normal">
                  Hides matching alerts
                </Badge>
              ) : null}
            </>
          ) : (
            <>
              <span className="font-medium">Analyze</span>
              <Link
                href={`/entries/${(payload as AnalyzeEntryPayload).entryId}`}
                className="font-medium text-blue-700 underline underline-offset-2 dark:text-blue-400"
              >
                entry {(payload as AnalyzeEntryPayload).entryNumber}
              </Link>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 justify-self-end">
          {proposal.status === "proposed" && !stale ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void confirm()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                Confirm
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void decline()}
              >
                Decline
              </Button>
            </>
          ) : proposal.status === "proposed" && stale ? (
            <>
              <Badge variant="outline" className="font-normal">
                Decided elsewhere
              </Badge>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void decline()}
              >
                Clear
              </Button>
            </>
          ) : (
            <Badge variant="outline" className="font-normal">
              {proposal.status === "confirmed" ? "Confirmed" : "Declined"}
            </Badge>
          )}
        </div>
        <p className="col-span-2 text-sm text-muted-foreground @md:col-span-1">
          {payload.kind === "alert_decision"
            ? payload.note
            : payload.kind === "save_org_rule"
              ? payload.text
              : (payload as AnalyzeEntryPayload).reason}
        </p>
      </div>
    </div>
  );
}
