"use client";

// One staged Chapter 99 revision: proposed-vs-live diff, evidence text with
// highlighted sail/entry date phrases (one-click chips fill the date
// fields), confirm-dates inputs, and Approve & apply / Reject. Approving
// runs the apply planner (window tiling) and a re-audit in one transaction
// — every value confirmed here is exactly what apply.ts writes.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OpenRevision } from "@/lib/db/queries/tariffs";
import { formatDate, formatRate } from "@/lib/format";
import type { SailClauseCandidate } from "@/lib/tariff-sync/types";

const CHANGE_LABEL: Record<OpenRevision["changeType"], string> = {
  create_measure: "New measure",
  rate_change: "Rate change",
  scope_change: "Scope change",
  end_measure: "Measure ends",
  stacking_change: "Stacking change",
  note_change: "Text change",
};

const AUTHORITY_LABEL: Record<string, string> = {
  section_301: "Section 301",
  section_232_steel: "232 Steel",
  section_232_aluminum: "232 Aluminum",
  ieepa: "IEEPA",
  reciprocal: "Reciprocal",
  section_122: "Section 122",
  other: "Other",
};

type DateField =
  | "effectiveDate"
  | "endDate"
  | "sailedOnOrAfter"
  | "sailedOnOrBefore";

// Where each highlighted clause kind lands when its chip is clicked. An
// exclusive "before D" bound converts to the inclusive D−1 the schema uses.
const CHIP_TARGET: Record<
  SailClauseCandidate["kind"],
  { field: DateField; label: string; adjust?: "dayBefore" }
> = {
  sail_before: { field: "sailedOnOrBefore", label: "sailed on/before", adjust: "dayBefore" },
  sail_on_or_after: { field: "sailedOnOrAfter", label: "sailed on/after" },
  entry_on_or_after: { field: "effectiveDate", label: "effective (entry) from" },
  entry_before: { field: "endDate", label: "entry window ends", adjust: "dayBefore" },
};

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function RevisionReviewCard({ revision }: { revision: OpenRevision }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<DateField, string | null>>({
    effectiveDate: revision.proposed.effectiveDate,
    endDate: revision.proposed.endDate,
    sailedOnOrAfter: revision.proposed.sailedOnOrAfter,
    sailedOnOrBefore: revision.proposed.sailedOnOrBefore,
  });

  async function decide(payload: Record<string, unknown>, pending: string) {
    setBusy(true);
    const toastId = toast.loading(pending);
    try {
      const res = await fetch(
        `/api/tariff-sync/revisions/${revision.revisionId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Update failed.");
      if (body?.action === "applied") {
        const audit = body.audit;
        toast.success(
          `${revision.ch99Code ?? "Revision"} applied` +
            (audit
              ? ` · ${audit.entries} entr${audit.entries === 1 ? "y" : "ies"} re-audited (${audit.created} new finding(s), ${audit.cleared} cleared)`
              : ""),
          { id: toastId },
        );
      } else {
        toast.success("Revision rejected.", { id: toastId });
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.", {
        id: toastId,
      });
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    if (!draft.effectiveDate && revision.changeType !== "end_measure") {
      toast.error(
        "Confirm the effective date before approving — the feed never carries it.",
      );
      return;
    }
    void decide(
      { action: "approve", ...draft },
      "Applying measure windows and re-auditing…",
    );
  }

  const live = revision.liveSnapshot;
  const highlights = revision.evidence.highlights ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Badge variant="outline">{CHANGE_LABEL[revision.changeType]}</Badge>
          {revision.ch99Code ? (
            <span className="font-mono">{revision.ch99Code}</span>
          ) : null}
          {revision.authority ? (
            <Badge variant="outline">
              {AUTHORITY_LABEL[revision.authority] ?? revision.authority}
            </Badge>
          ) : null}
          <span className="font-normal text-muted-foreground">
            {revision.proposed.name}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ProposedDiff revision={revision} live={live} />

        <EvidenceText
          description={revision.evidence.description}
          general={revision.evidence.general}
          highlights={highlights}
        />

        {highlights.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {highlights.map((h, i) => {
                const target = CHIP_TARGET[h.kind];
                const value =
                  target.adjust === "dayBefore" ? dayBefore(h.isoDate) : h.isoDate;
                return (
                  <Button
                    key={i}
                    variant="secondary"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() =>
                      setDraft((d) => ({ ...d, [target.field]: value }))
                    }
                  >
                    {target.label} → {value}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Highlighted dates are evidence only — nothing applies until you
              confirm them below.
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ["effectiveDate", "Effective (entry)"],
              ["endDate", "Entry window ends"],
              ["sailedOnOrAfter", "Sailed on/after"],
              ["sailedOnOrBefore", "Sailed on/before"],
            ] as const
          ).map(([field, label]) => (
            <div key={field} className="space-y-1">
              <Label className="text-xs">{label}</Label>
              <Input
                type="date"
                value={draft[field] ?? ""}
                disabled={busy}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [field]: e.target.value || null }))
                }
              />
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Button size="sm" onClick={approve} disabled={busy}>
            <Check /> Approve &amp; apply
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void decide({ action: "reject" }, "Rejecting…")}
          >
            <X /> Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Compact proposed-vs-live diff. Only the load-bearing fields: rate, entry
 *  window, sail conditions. */
function ProposedDiff({
  revision,
  live,
}: {
  revision: OpenRevision;
  live: OpenRevision["liveSnapshot"];
}) {
  const proposed = revision.proposed;
  return (
    <div className="space-y-1 text-sm">
      <div>
        <span className="text-muted-foreground">Rate: </span>
        {live && live.rate !== proposed.rate ? (
          <>
            <span className="font-mono line-through opacity-60">
              {formatRate(live.rate)}
            </span>
            <span className="mx-2">→</span>
          </>
        ) : null}
        <span className="font-mono font-semibold">
          {proposed.rate === null
            ? proposed.exemption
              ? "exempt"
              : "?"
            : formatRate(proposed.rate)}
        </span>
        {proposed.exemption && proposed.rate !== null ? (
          <span className="ml-2 text-xs text-muted-foreground">(exemption)</span>
        ) : null}
      </div>
      {live ? (
        <div className="text-muted-foreground">
          Live window: {formatDate(live.effectiveDate)} →{" "}
          {live.endDate ? formatDate(live.endDate) : "open"}
          {live.sailedOnOrAfter
            ? ` · sailed ≥ ${formatDate(live.sailedOnOrAfter)}`
            : ""}
          {live.sailedOnOrBefore
            ? ` · sailed ≤ ${formatDate(live.sailedOnOrBefore)}`
            : ""}
        </div>
      ) : (
        <div className="text-muted-foreground">
          {revision.changeType === "end_measure"
            ? "Proposes ending the live measure."
            : "No live counterpart — this creates a new measure."}
        </div>
      )}
    </div>
  );
}

/** Evidence text with the highlighter's date phrases <mark>ed. h.index is
 *  the date-match offset in the source description. */
function EvidenceText({
  description,
  general,
  highlights,
}: {
  description: string;
  general: string;
  highlights: SailClauseCandidate[];
}) {
  const marked: React.ReactNode[] = [];
  let cursor = 0;
  for (const h of [...highlights].sort((a, b) => a.index - b.index)) {
    if (h.index >= cursor) {
      marked.push(description.slice(cursor, h.index));
      const dateLen =
        description
          .slice(h.index)
          .match(/^[A-Za-z]+\s+\d{1,2},\s+\d{4}/)?.[0]?.length ?? 0;
      marked.push(
        <mark
          key={h.index}
          className="rounded bg-amber-200 px-0.5 dark:bg-amber-800"
        >
          {description.slice(h.index, h.index + dateLen)}
        </mark>,
      );
      cursor = h.index + dateLen;
    }
  }
  marked.push(description.slice(cursor));

  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm leading-relaxed">
      {marked}
      {general ? (
        <div className="mt-2 font-mono text-xs text-muted-foreground">
          General: {general}
        </div>
      ) : null}
    </div>
  );
}
