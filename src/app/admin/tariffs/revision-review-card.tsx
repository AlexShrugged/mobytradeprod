"use client";

// One staged Chapter 99 measure change: a scope/rate summary, a live-vs-
// proposed field diff (the variance idiom applied to reference data),
// evidence text with highlighted date phrases, extraction suggestions with
// per-field confidence, and the reviewer's confirmable fields — the date
// windows and the COUNTRY SCOPE. Country scope is editable for the same
// reason dates are: the structured feed doesn't carry it reliably, and
// approving a country-specific measure with an empty scope would apply it
// to every origin. Every value confirmed here is exactly what apply.ts
// writes — nothing lands without this card.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OpenRevision } from "@/lib/db/queries/tariffs";
import { formatDate } from "@/lib/format";
import { inferProgram } from "@/lib/tariff-sync/programs";
import {
  coverageLabel,
  diffRevisionFields,
  rateLabel,
} from "@/lib/tariff-sync/revision-diff";
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
  section_232_copper: "232 Copper",
  section_232_autos: "232 Autos",
  section_232_timber_furniture: "232 Timber & Furniture",
  section_232_pharma: "232 Pharma",
  section_338: "Section 338",
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

const DATE_FIELD_LABEL: Record<DateField, string> = {
  effectiveDate: "Effective (entry)",
  endDate: "Entry window ends",
  sailedOnOrAfter: "Sailed on/after",
  sailedOnOrBefore: "Sailed on/before",
};

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

/** "cn, hk" → ["CN","HK"]; blank/garbage → null (= all countries). */
function parseCountriesInput(text: string): string[] | null {
  const codes = [
    ...new Set(
      text
        .split(/[,\s]+/)
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z]{2}$/.test(c)),
    ),
  ];
  return codes.length > 0 ? codes : null;
}

export function RevisionReviewCard({ revision }: { revision: OpenRevision }) {
  const router = useRouter();
  const proposed = revision.proposed;
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<DateField, string | null>>({
    effectiveDate: proposed.effectiveDate,
    endDate: proposed.endDate,
    sailedOnOrAfter: proposed.sailedOnOrAfter,
    sailedOnOrBefore: proposed.sailedOnOrBefore,
  });
  const [countriesText, setCountriesText] = React.useState(
    proposed.countries?.join(", ") ?? "",
  );
  const [excludedText, setExcludedText] = React.useState(
    proposed.countriesExcluded?.join(", ") ?? "",
  );
  // Revisions staged before program inference existed (absent field, not
  // an explicit null) default to the same inference staging now runs, so
  // the reviewer sees and confirms a concrete value either way.
  const [programText, setProgramText] = React.useState(
    proposed.program !== undefined
      ? (proposed.program ?? "")
      : (inferProgram(
          proposed.authority,
          revision.ch99Code ?? "",
          revision.evidence.description ?? "",
        ) ?? ""),
  );
  const [worldwide, setWorldwide] = React.useState(proposed.worldwide ?? false);
  const [onConflict, setOnConflict] = React.useState<"supersede" | "stack" | "">(
    proposed.onConflict ?? "",
  );

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
        "Confirm the effective date before approving.",
      );
      return;
    }
    void decide(
      {
        action: "approve",
        ...draft,
        countries: parseCountriesInput(countriesText),
        countriesExcluded: parseCountriesInput(excludedText),
        // Only create_measure carries the program-gate decisions: sending
        // them on change revisions would clear the live measure's program
        // when the staged proposal predates the field.
        ...(revision.changeType === "create_measure"
          ? {
              program: programText.trim() === "" ? null : programText.trim(),
              worldwide,
              onConflict: onConflict === "" ? null : onConflict,
            }
          : {}),
      },
      "Applying measure windows and re-auditing…",
    );
  }

  const live = revision.liveSnapshot;
  const highlights = revision.evidence.highlights ?? [];
  const extraction = revision.evidence.extraction;
  const diffRows = diffRevisionFields(
    live,
    proposed,
    revision.evidence.description || undefined,
  );

  // Extraction suggestions worth a chip: fields the reviewer can act on
  // that the proposal hasn't already settled.
  const dateSuggestions = extraction
    ? (Object.keys(DATE_FIELD_LABEL) as DateField[])
        .map((field) => ({ field, ex: extraction[field] }))
        .filter(
          ({ field, ex }) =>
            ex.value !== null && draft[field] === null,
        )
    : [];
  const countrySuggestion =
    extraction &&
    extraction.countries.value !== null &&
    countriesText.trim() === ""
      ? extraction.countries
      : null;

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
            {proposed.name}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* What this measure IS: rate, scope, coverage — the fields an
            approver must see before anything else. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>
            <span className="text-muted-foreground">Rate: </span>
            <span className="font-mono font-semibold">{rateLabel(proposed)}</span>
            {proposed.rate === null && !proposed.exemption && proposed.rateText ? (
              <span className="ml-1.5 text-xs text-muted-foreground">
                (non-ad-valorem; presence-only, amount not auto-checked)
              </span>
            ) : null}
          </span>
          <span>
            <span className="text-muted-foreground">Coverage: </span>
            {coverageLabel(proposed)}
          </span>
          {proposed.exemption ? <Badge variant="secondary">exemption</Badge> : null}
        </div>
        {proposed.notes ? (
          <p className="text-xs text-muted-foreground">{proposed.notes}</p>
        ) : null}

        {/* Live-vs-proposed field diff — what actually changes on approve. */}
        {diffRows.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <tbody>
                {diffRows.map((row) => (
                  <tr key={row.field} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-2 py-1.5 font-medium text-muted-foreground">
                      {row.field}
                    </td>
                    <td className="px-2 py-1.5 line-through opacity-60">
                      {row.live}
                    </td>
                    <td className="px-2 py-1.5 font-medium">{row.proposed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {live ? (
          <div className="text-sm text-muted-foreground">
            Live window: {formatDate(live.effectiveDate)} →{" "}
            {live.endDate ? formatDate(live.endDate) : "open"}
            {live.sailedOnOrAfter
              ? ` · sailed ≥ ${formatDate(live.sailedOnOrAfter)}`
              : ""}
            {live.sailedOnOrBefore
              ? ` · sailed ≤ ${formatDate(live.sailedOnOrBefore)}`
              : ""}
          </div>
        ) : revision.changeType === "end_measure" ? (
          <div className="text-sm text-muted-foreground">
            Proposes ending the live measure.
          </div>
        ) : null}

        <EvidenceText
          description={revision.evidence.description}
          general={revision.evidence.general}
          highlights={highlights}
        />

        {highlights.length > 0 || dateSuggestions.length > 0 || countrySuggestion ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {highlights.map((h, i) => {
                const target = CHIP_TARGET[h.kind];
                const value =
                  target.adjust === "dayBefore" ? dayBefore(h.isoDate) : h.isoDate;
                return (
                  <Button
                    key={`h${i}`}
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
              {dateSuggestions.map(({ field, ex }) => (
                <Button
                  key={`x${field}`}
                  variant="secondary"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  title={ex.evidence ?? undefined}
                  onClick={() =>
                    setDraft((d) => ({ ...d, [field]: ex.value }))
                  }
                >
                  <Sparkles className="size-3" />
                  {DATE_FIELD_LABEL[field]} → {ex.value} (
                  {Math.round(ex.confidence * 100)}%)
                </Button>
              ))}
              {countrySuggestion ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  title={countrySuggestion.evidence ?? undefined}
                  onClick={() =>
                    setCountriesText(countrySuggestion.value!.join(", "))
                  }
                >
                  <Sparkles className="size-3" />
                  countries → {countrySuggestion.value!.join(", ")} (
                  {Math.round(countrySuggestion.confidence * 100)}%)
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Highlights and extraction suggestions are evidence only. Nothing
              applies until you confirm it below.
            </p>
          </div>
        ) : null}

        {/* Reviewer-confirmed scope. Blank countries = applies to every
            origin — leaving it blank on a country-specific measure is the
            costly mistake this input exists to prevent. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">
              Countries of origin (blank = all countries)
            </Label>
            <Input
              value={countriesText}
              placeholder="e.g. CN, HK"
              disabled={busy}
              onChange={(e) => setCountriesText(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Excluded countries</Label>
            <Input
              value={excludedText}
              placeholder="e.g. CA, MX"
              disabled={busy}
              onChange={(e) => setExcludedText(e.target.value)}
            />
          </div>
        </div>

        {revision.changeType === "create_measure" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Program</Label>
              <Input
                value={programText}
                placeholder="e.g. ieepa-reciprocal"
                disabled={busy}
                onChange={(e) => setProgramText(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">On overlap with a live measure</Label>
              <Select
                value={onConflict === "" ? undefined : onConflict}
                disabled={busy}
                onValueChange={(v) =>
                  setOnConflict(v as "supersede" | "stack")
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Block apply" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="supersede">Supersede</SelectItem>
                  <SelectItem value="stack">Stack</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 sm:mt-5">
              <Checkbox
                id={`worldwide-${revision.revisionId}`}
                checked={worldwide}
                disabled={busy}
                onCheckedChange={(v) => setWorldwide(v === true)}
              />
              <Label
                htmlFor={`worldwide-${revision.revisionId}`}
                className="text-xs"
              >
                Applies to every country
              </Label>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(Object.keys(DATE_FIELD_LABEL) as DateField[]).map((field) => (
            <div key={field} className="space-y-1">
              <Label className="text-xs">{DATE_FIELD_LABEL[field]}</Label>
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
            <Check /> Approve
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
