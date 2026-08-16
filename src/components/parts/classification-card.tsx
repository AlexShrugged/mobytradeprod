"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ListTree } from "lucide-react";
import { toast } from "sonner";

import { HtsCode } from "@/components/hts-code";
import { EditableCell } from "@/components/inline-edit";
import { reauditToast } from "@/components/parts/hts-review-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PartRow } from "@/lib/db/queries/parts";
import { formatDate, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";

// The part's classification panel, two modes:
//
// SIMPLE (no open review): the committed code, click-to-edit exactly like
// the Name cell (EditableCell → PATCH /api/parts/[partId], which commits
// the window, supersedes any pending review, re-audits), plus an Analyze
// button that runs the classifier.
//
// REVIEWING (open review item): every code option is a selectable card —
// the committed one tagged "current", alternatives with the classifier's
// confidence and a green saving tag when deterministic duty math says the
// code is strictly cheaper under today's measures (derived on read, never
// stored). The selected card carries the same amber tint the variance
// table uses for the row in question, and Accept/Dismiss below mirror the
// variance decision buttons: Accept commits the selected code, Dismiss
// keeps the current one and clears the options. Both act on the review
// item, so queue status and part projection stay consistent. Review on the
// selected alternative opens the full dialog preselected to it — optional,
// never required.
export function ClassificationCard({
  part,
  onReview,
}: {
  part: PartRow;
  onReview: (partId: string, code?: string) => void;
}) {
  const cls = part.classification;
  const reviewing =
    part.openReviewItemId !== null &&
    part.openReviewKind !== null &&
    cls !== null;
  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          <ListTree className="size-4" /> Classification
        </h4>
        {/* Dated only while an analysis awaits a decision — a resolved run
            is history, not a label on the committed code. "AI" only when
            Claude actually produced it. */}
        {reviewing ? (
          <span className="text-xs text-muted-foreground">
            {cls!.classifier === "claude" ? "AI · " : ""}
            {formatDate(cls!.classifiedAt)}
          </span>
        ) : null}
      </div>
      {reviewing ? (
        <ReviewingBody part={part} onReview={onReview} />
      ) : (
        <SimpleBody part={part} onReview={onReview} />
      )}
    </div>
  );
}

function SimpleBody({
  part,
  onReview,
}: {
  part: PartRow;
  onReview: (partId: string, code?: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <EditableCell
        endpoint={`/api/parts/${part.id}`}
        field="htsCode"
        value={part.htsCode ?? ""}
        display={
          part.htsCode ? (
            <HtsCode code={part.htsCode} className="text-sm font-medium" />
          ) : undefined
        }
        placeholder="add code"
        className="text-sm"
      />
      {part.htsCodeProvisional ? (
        <Badge
          variant="outline"
          className="font-normal text-muted-foreground"
          title="Auto-selected by the classifier; not yet human-committed. Ignored by audits."
        >
          provisional
        </Badge>
      ) : null}
      <div className="ml-auto flex items-center gap-1.5">
        {/* A pending review without a stored run (seeded items) can only be
            worked in the dialog. */}
        {part.openReviewItemId !== null ? (
          <Button
            variant="outline"
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              onReview(part.id);
            }}
          >
            Review
          </Button>
        ) : null}
        <AnalyzeButton part={part} />
      </div>
    </div>
  );
}

function AnalyzeButton({ part }: { part: PartRow }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function analyze() {
    setBusy(true);
    try {
      const res = await fetch(`/api/parts/${part.id}/classify`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? "Analysis failed.");
      }
      toast.success(`${part.sku} analyzed.`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="xs"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        void analyze();
      }}
    >
      {busy ? "Analyzing…" : "Analyze"}
    </Button>
  );
}

function ReviewingBody({
  part,
  onReview,
}: {
  part: PartRow;
  onReview: (partId: string, code?: string) => void;
}) {
  const router = useRouter();
  const cls = part.classification!;
  // Selection key: "current" or the suggestion's codeDigits.
  const [selected, setSelected] = React.useState<string>(
    part.htsCode !== null
      ? "current"
      : (cls.suggestions[0]?.codeDigits ?? "current"),
  );
  const [effectiveDate, setEffectiveDate] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const selectedSuggestion =
    selected === "current"
      ? null
      : (cls.suggestions.find((s) => s.codeDigits === selected) ?? null);

  async function decide(
    body: Record<string, unknown>,
    successPrefix: string,
  ) {
    setBusy(true);
    try {
      const res = await fetch(`/api/review-items/${part.openReviewItemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          effectiveDate: effectiveDate || undefined,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? "The review action failed.");
      }
      toast.success(`${successPrefix}${reauditToast(payload?.reaudit)}`);
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "The review action failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Dismiss keeps the committed code and closes the options: reject for a
  // suggestion, acknowledge for a confirmation. Accept commits the
  // selected alternative (accept/manual by kind) — or, with the current
  // card selected, means the same thing as Dismiss.
  function dismiss() {
    if (part.openReviewKind === "confirmation") {
      void decide({ action: "acknowledge" }, `${part.sku} confirmed.`);
    } else {
      void decide(
        { action: "reject" },
        `Suggestion rejected for ${part.sku}.`,
      );
    }
  }

  function accept() {
    if (selectedSuggestion === null) {
      dismiss();
      return;
    }
    void decide(
      {
        action: part.openReviewKind === "suggestion" ? "accept" : "manual",
        code: selectedSuggestion.code,
      },
      `${selectedSuggestion.code} committed to ${part.sku}`,
    );
  }

  const cardClass = (isSelected: boolean) =>
    cn(
      "cursor-pointer rounded-md border p-3 transition-colors",
      // Selected reuses the variance nav card's current-item treatment
      // (muted fill + ring — not amber, which reads as a problem);
      // unselected gets the outline-button solid hover, not the table
      // rows' faint bg-muted/50 — these are small click targets.
      isSelected
        ? "border-ring bg-muted ring-1 ring-ring/40"
        : "hover:bg-accent",
    );

  return (
    <>
      <div className="flex flex-col gap-2 p-3">
        {part.htsCode !== null ? (
          <div
            className={cardClass(selected === "current")}
            onClick={() => setSelected("current")}
          >
            <div className="flex items-center gap-2">
              <HtsCode code={part.htsCode} className="text-sm font-medium" />
              <Badge variant="secondary" className="font-normal">
                current
              </Badge>
              {part.htsCodeProvisional ? (
                <Badge
                  variant="outline"
                  className="font-normal text-muted-foreground"
                  title="Auto-selected by the classifier; not yet human-committed. Ignored by audits."
                >
                  provisional
                </Badge>
              ) : null}
              {cls.currentConfidence !== null ? (
                <span
                  className="text-xs text-muted-foreground tabular-nums"
                  title="The classifier's latest run independently agrees with this code"
                >
                  {Math.round(cls.currentConfidence * 100)}%
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        {cls.suggestions.map((s) => (
          <div
            key={s.codeDigits}
            title={s.reason ?? undefined}
            className={cardClass(selected === s.codeDigits)}
            onClick={() => setSelected(s.codeDigits)}
          >
            <div className="flex items-center gap-2">
              <HtsCode
                code={s.code}
                compareTo={part.htsCode}
                className="text-sm font-medium"
              />
              {s.confidence !== null ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Math.round(s.confidence * 100)}%
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-1.5">
                {s.savingRate !== null ? (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/20 bg-emerald-500/10 font-normal text-emerald-700 dark:text-emerald-400"
                    title="Lower total duty than the current code under today's tariff measures for every sourced origin"
                  >
                    saves {formatRate(s.savingRate)} duty
                  </Badge>
                ) : null}
                {selected === s.codeDigits ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReview(part.id, s.code);
                    }}
                  >
                    Review
                  </Button>
                ) : null}
              </div>
            </div>
            {s.description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {s.description}
              </p>
            ) : null}
          </div>
        ))}
        {selectedSuggestion !== null ? (
          <div className="flex flex-col gap-1.5 pt-1">
            <Label
              htmlFor={`effective-${part.id}`}
              className="text-xs text-muted-foreground"
            >
              Effective from (optional)
            </Label>
            <Input
              id={`effective-${part.id}`}
              type="date"
              value={effectiveDate}
              disabled={busy}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="h-8 w-44"
            />
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Button size="sm" disabled={busy} onClick={accept}>
          Accept
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </>
  );
}
