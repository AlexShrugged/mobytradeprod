"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ReauditSummary } from "@/lib/audit/auditor";
import type { HtsReviewQueueItem } from "@/lib/db/queries/parts";
import { cn } from "@/lib/utils";

export function reauditToast(reaudit: ReauditSummary | null | undefined): string {
  if (!reaudit || reaudit.entries === 0) return "";
  const parts = [`re-audited ${reaudit.entries} entr${reaudit.entries === 1 ? "y" : "ies"}`];
  if (reaudit.cleared > 0) parts.push(`${reaudit.cleared} finding${reaudit.cleared === 1 ? "" : "s"} cleared`);
  if (reaudit.created > 0)
    parts.push(
      `${reaudit.created} new finding${reaudit.created === 1 ? "" : "s"} (money checks re-enabled)`,
    );
  return `; ${parts.join(", ")}`;
}

export function HtsReviewDialog({
  queue,
  openIndex,
  onOpenChange,
  preselect = null,
}: {
  queue: HtsReviewQueueItem[];
  openIndex: number | null;
  onOpenChange: (index: number | null) => void;
  /** Candidate to open selected — set when a suggestion card on the part
   *  expansion launched the dialog. Scoped by part id so walking to the
   *  next queue item never inherits another part's preselect. */
  preselect?: { partId: string; code: string } | null;
}) {
  const item = openIndex === null ? null : (queue[openIndex] ?? null);

  // ONE persistent Dialog across the whole walk: only the inner body is
  // keyed by item id, so stepping between queue items swaps content in
  // place — no overlay fade or panel pop between items, and the arrows
  // stay under the cursor. Opening and closing still animate normally.
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(null);
      }}
    >
      <DialogContent className="p-0 sm:max-w-2xl">
        {item !== null && openIndex !== null ? (
          <>
            {/* Keyed scroll wrapper: fresh selection/notes state AND a
                reset scroll position per item. */}
            <div
              key={item.item.id}
              className="grid max-h-[94vh] gap-3 overflow-y-auto rounded-lg p-6"
            >
              <ReviewDialogBody
                queueItem={item}
                queueLength={queue.length}
                openIndex={openIndex}
                onOpenChange={onOpenChange}
                initialSelectedCode={
                  preselect !== null && preselect.partId === item.part.id
                    ? preselect.code
                    : null
                }
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReviewDialogBody({
  queueItem,
  queueLength,
  openIndex,
  onOpenChange,
  initialSelectedCode = null,
}: {
  queueItem: HtsReviewQueueItem;
  queueLength: number;
  openIndex: number;
  onOpenChange: (index: number | null) => void;
  initialSelectedCode?: string | null;
}) {
  const router = useRouter();
  const { proposal, part, classification, declaredCodes } = queueItem;
  const isConfirmation = proposal.kind === "confirmation";

  const [selectedCode, setSelectedCode] = React.useState<string | null>(
    initialSelectedCode ?? proposal.suggestedCode,
  );
  const [manualCode, setManualCode] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [effectiveDate, setEffectiveDate] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function act(body: Record<string, unknown>, successPrefix: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/review-items/${queueItem.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          notes: notes || undefined,
          effectiveDate: effectiveDate || undefined,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? "The review action failed.");
      }
      toast.success(`${successPrefix}${reauditToast(payload?.reaudit)}`);
      router.refresh();
      // The decided item leaves the queue on refresh; the same index then
      // points at the next item. Close when this was the last one.
      if (openIndex >= queueLength - 1) onOpenChange(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The review action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader className="gap-1">
        {/* Queue pager, top-left on the close button's row. */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={openIndex === 0}
            onClick={() => onOpenChange(openIndex - 1)}
            aria-label="Previous item"
          >
            <ChevronLeft />
          </Button>
          <span className="whitespace-nowrap tabular-nums">
            {openIndex + 1} of {queueLength}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={openIndex >= queueLength - 1}
            onClick={() => onOpenChange(openIndex + 1)}
            aria-label="Next item (skip)"
          >
            <ChevronRight />
          </Button>
        </div>
        <DialogTitle className="text-base">
          {part.sku} · {part.name}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Review the HTS classification for {part.sku}.
        </DialogDescription>
      </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">
              Current catalog code
            </div>
            <div className="mt-1 font-medium tabular-nums">
              {proposal.currentCode ??
                (part.htsCodeProvisional && part.htsCode
                  ? `${part.htsCode} (provisional)`
                  : "none")}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">
              Suggested catalog code
            </div>
            <div className="mt-1 font-medium tabular-nums">
              {proposal.suggestedCode ?? "—"}
            </div>
          </div>
        </div>

        {declaredCodes.length > 0 ? (
          <div className="rounded-md border p-3">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Declared on entries (broker evidence)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {declaredCodes.map((d) => (
                <Badge
                  key={d.htsCode}
                  variant="outline"
                  className="font-normal tabular-nums"
                >
                  {d.htsCode} × {d.lineCount} line{d.lineCount === 1 ? "" : "s"}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {classification ? (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Candidates
            </div>
            {classification.candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                onClick={() => setSelectedCode(c.code)}
                className={cn(
                  // Same treatment as the expansion card's option stack:
                  // the nav-card muted-fill + ring when selected, the
                  // outline-button solid hover on the rest.
                  "cursor-pointer rounded-md border p-3 text-left transition-colors",
                  selectedCode === c.code
                    ? "border-ring bg-muted ring-1 ring-ring/40"
                    : "hover:bg-accent",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium tabular-nums">{c.code}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.confidence === null
                      ? ""
                      : `${Math.round(Number(c.confidence) * 100)}%`}
                  </span>
                </div>
                {c.description ? (
                  <div className="text-xs text-muted-foreground">
                    {c.description}
                  </div>
                ) : null}
                {c.reason ? (
                  <div className="mt-1 text-xs">{c.reason}</div>
                ) : null}
              </button>
            ))}
            {classification.reasoning ? (
              <p className="text-xs text-muted-foreground">
                {classification.reasoning}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-hts" className="text-xs">
            Manual code (8 or 10 digits; overrides the candidates)
          </Label>
          <Input
            id="manual-hts"
            placeholder="e.g. 8714.94.9000"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            className="tabular-nums"
          />
          {manualCode.trim() !== "" ? (
            <p className="text-xs text-muted-foreground">
              Codes outside the reference schedule are allowed; duty
              expectations stay unavailable until the schedule covers them.
            </p>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="review-notes" className="text-xs">
              Notes
            </Label>
            <Input
              id="review-notes"
              placeholder="Why this decision…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="review-effective-date" className="text-xs">
              Effective from (optional)
            </Label>
            <Input
              id="review-effective-date"
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank if this code was always correct; set a date to
              reclassify from that day forward.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {manualCode.trim() !== "" ? (
            <Button
              disabled={busy}
              onClick={() =>
                act(
                  { action: "manual", code: manualCode.trim() },
                  `Manual code applied to ${part.sku}.`,
                )
              }
            >
              Apply manual code
            </Button>
          ) : isConfirmation ? (
            // Confirmations have nothing to accept — unless the reviewer
            // picks a candidate OTHER than the confirmed code, which is an
            // override and commits through the manual action (the state
            // machine reserves "accept" for suggestions).
            selectedCode !== null && selectedCode !== proposal.currentCode ? (
              <Button
                disabled={busy}
                onClick={() =>
                  act(
                    { action: "manual", code: selectedCode },
                    `${selectedCode} committed to ${part.sku}.`,
                  )
                }
              >
                Accept {selectedCode}
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() =>
                  act({ action: "acknowledge" }, `${part.sku} confirmed.`)
                }
              >
                Accept
              </Button>
            )
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act({ action: "reject" }, `Suggestion rejected for ${part.sku}.`)
                }
              >
                Reject
              </Button>
              <Button
                disabled={busy || selectedCode === null}
                onClick={() =>
                  act(
                    { action: "accept", code: selectedCode },
                    `${selectedCode} committed to ${part.sku}.`,
                  )
                }
              >
                Accept {selectedCode ?? ""}
              </Button>
            </>
          )}
        </div>
    </>
  );
}
