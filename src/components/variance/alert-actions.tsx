"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RotateCcw, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type AlertStatus = "open" | "resolved" | "dismissed";

async function patchStatus(id: string, status: AlertStatus) {
  const res = await fetch(`/api/alerts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? "Failed to update the variance.");
  }
}

// Decide the variance. "Accept" takes the Expected side as the answer
// (persisted as status "resolved" — per-type actions like PSC drafting come
// later); Dismiss closes it as not actionable. Decisions apply to the whole
// UNIT: a rate mismatch and its duty-amount twin are one finding, so every
// PATCH covers `decideIds`. Same contract as the entry page's alert list;
// the auditor never touches resolved/dismissed rows, so the decision
// sticks. Either decision auto-advances to the next open unit on the line,
// or — when the line is done — back to wherever the flow was entered (the
// entry page for ?from=entry, the queue otherwise). In-flow navigation
// REPLACES history, so the whole review occupies one history slot and
// browser back always exits to the flow's origin. The toast carries an
// Undo that reopens the decision(s) and returns here.
export function AlertActions({
  alertId,
  status,
  alertType,
  partId,
  entryId,
  fromEntry = false,
  decideIds,
  nextOpenAlertId = null,
  lineUnits = [],
  undoPrevious = null,
}: {
  alertId: string;
  status: AlertStatus;
  alertType: string;
  partId: string | null;
  entryId: string;
  /** True when the review flow was entered from the entry page — in-flow
   *  links keep ?from=entry and completing the line lands on the entry. */
  fromEntry?: boolean;
  /** Every alert id this page's decision covers (the current unit — the
   *  alert itself plus its rate/amount twin, when one exists). */
  decideIds?: string[];
  /** Auto-advance target after Accept/Dismiss; null returns to /variance. */
  nextOpenAlertId?: string | null;
  /** The line's decidable units in card order — feeds the completion
   *  summary toast (counting units, not rows) and its undo-all. */
  lineUnits?: { ids: string[]; status: AlertStatus }[];
  /** The decided unit directly above this one in card order — shows an
   *  inline Undo that reopens it and steps back to it. */
  undoPrevious?: { ids: string[]; backTo: string } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const ids = decideIds && decideIds.length > 0 ? decideIds : [alertId];
  const flowQs = fromEntry ? "?from=entry" : "";

  // Undo: reopen whole units and land on `backToId`. `unitCount` words the
  // toast (a two-row pair is still ONE variance). Toast-borne calls outlive
  // this component (it unmounts on auto-advance), but the closure (fetch +
  // app router) stays valid from the Toaster.
  async function undo(undoIds: string[], backToId = alertId, unitCount = 1) {
    try {
      await Promise.all(undoIds.map((id) => patchStatus(id, "open")));
      toast.success(
        unitCount === 1 ? "Variance reopened." : "Variances reopened.",
        { richColors: false },
      );
      router.replace(`/variance/${backToId}${flowQs}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Undo failed.");
      router.refresh();
    }
  }

  async function setStatus(next: AlertStatus) {
    setBusy(true);
    try {
      await Promise.all(ids.map((id) => patchStatus(id, next)));
      if (next === "open") {
        toast.success("Variance reopened — the auditor owns it again.", {
          richColors: false,
        });
        router.refresh();
        return;
      }
      const decidedLabel =
        next === "dismissed" ? "Variance dismissed." : "Variance accepted.";
      if (nextOpenAlertId) {
        toast.success(decidedLabel, {
          richColors: false,
          duration: 6000,
          action: { label: "Undo", onClick: () => void undo(ids) },
        });
        router.replace(`/variance/${nextOpenAlertId}${flowQs}`);
      } else {
        // Line complete — summarize every decided unit on it; undo reopens
        // them all and returns to this variance.
        const base =
          lineUnits.length > 0
            ? lineUnits
            : [{ ids, status: "open" as AlertStatus }];
        const decided = base
          .map((u) => (u.ids.includes(alertId) ? { ...u, status: next } : u))
          .filter((u) => u.status !== "open");
        const accepted = decided.filter((u) => u.status === "resolved").length;
        const dismissed = decided.filter(
          (u) => u.status === "dismissed",
        ).length;
        const summary = [
          accepted > 0 ? `${accepted} accepted` : null,
          dismissed > 0 ? `${dismissed} dismissed` : null,
        ]
          .filter(Boolean)
          .join(", ");
        toast.success(summary || decidedLabel, {
          richColors: false,
          duration: 8000,
          action: {
            label: "Undo",
            onClick: () =>
              void undo(
                decided.flatMap((u) => u.ids),
                alertId,
                decided.length,
              ),
          },
        });
        router.replace(fromEntry ? `/entries/${entryId}` : "/variance");
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  if (status !== "open") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setStatus("open")}
        >
          <RotateCcw /> Reopen
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => setStatus("resolved")}>
        Accept
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => setStatus("dismissed")}
      >
        Dismiss
      </Button>
      {undoPrevious ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          title="Reopen the previous issue and go back to it"
          onClick={async () => {
            setBusy(true);
            try {
              await undo(undoPrevious.ids, undoPrevious.backTo);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Undo2 /> Undo
        </Button>
      ) : null}
      {(alertType === "hts_discrepancy" || alertType === "hts_reclassified") &&
      partId ? (
        <Button variant="outline" size="sm" asChild>
          <Link
            href={`/parts?review=${partId}`}
            title="Open this part in the HTS review queue"
          >
            Reclassify part
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
