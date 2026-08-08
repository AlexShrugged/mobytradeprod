"use client";

// One wholesale-adoption family ("Adopt 9903.88.xx — Section 301"): a
// member table with per-code proposed rate/dates and extraction-confidence
// hints, per-member exclude checkboxes, a default-effective-date input for
// members whose date is still null, and Approve & apply / Reject. Apply is
// all-or-nothing — a failing member rolls the whole approval back with its
// code listed, so the reviewer excludes it or fixes the default date and
// retries.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OpenMeasureGroup } from "@/lib/db/queries/tariffs";
import { formatRate } from "@/lib/format";

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

function memberRateLabel(m: OpenMeasureGroup["members"][number]): string {
  if (m.exemption) return "exempt";
  if (m.rate !== null) return formatRate(m.rate);
  return m.rateText ?? "?";
}

export function GroupReviewCard({ group }: { group: OpenMeasureGroup }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [excluded, setExcluded] = React.useState<Set<string>>(new Set());
  const [defaultEffectiveDate, setDefaultEffectiveDate] = React.useState("");
  const [defaultEndDate, setDefaultEndDate] = React.useState("");
  // Per-member effective dates — the one field the feed never carries, and
  // the one that legitimately differs across a family's members. Prefilled
  // from the proposal (extraction can settle it); the default fills blanks.
  const [memberDates, setMemberDates] = React.useState<Record<string, string>>(
    () =>
      Object.fromEntries(
        group.members.map((m) => [m.revisionId, m.effectiveDate ?? ""]),
      ),
  );

  const undatedIncluded = group.members.filter(
    (m) => !excluded.has(m.revisionId) && !memberDates[m.revisionId],
  ).length;
  const includedCount = group.members.length - excluded.size;

  /** The default is a fill-all convenience: it populates every row that is
   *  blank (or still carrying the previous default), and never touches a
   *  date the reviewer typed per row. Clearing it re-blanks the rows it
   *  had filled. */
  function changeDefaultEffectiveDate(next: string) {
    setMemberDates((d) => {
      const updated = { ...d };
      for (const m of group.members) {
        const current = d[m.revisionId] ?? "";
        if (current === "" || current === defaultEffectiveDate) {
          updated[m.revisionId] = next;
        }
      }
      return updated;
    });
    setDefaultEffectiveDate(next);
  }

  async function decide(payload: Record<string, unknown>, pending: string) {
    setBusy(true);
    const toastId = toast.loading(pending);
    try {
      const res = await fetch(`/api/tariff-sync/groups/${group.groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Update failed.");
      if (body?.action === "applied") {
        const audit = body.audit;
        toast.success(
          `${group.title}: ${body.applied} measure(s) applied` +
            (body.rejected > 0 ? ` · ${body.rejected} rejected` : "") +
            (audit
              ? ` · ${audit.entries} entr${audit.entries === 1 ? "y" : "ies"} re-audited (${audit.created} new finding(s), ${audit.cleared} cleared)`
              : ""),
          { id: toastId, duration: 8000 },
        );
      } else {
        toast.success("Adoption group rejected.", { id: toastId });
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.", {
        id: toastId,
        duration: 10000,
      });
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    if (undatedIncluded > 0 && !defaultEffectiveDate) {
      toast.error(
        `${undatedIncluded} included code(s) have no effective date — enter them per row, set the default below, or uncheck them for individual review. The feed never carries dates.`,
      );
      return;
    }
    void decide(
      {
        action: "approve",
        defaultEffectiveDate: defaultEffectiveDate || null,
        defaultEndDate: defaultEndDate || null,
        memberEffectiveDates: Object.fromEntries(
          group.members
            .filter(
              (m) => !excluded.has(m.revisionId) && memberDates[m.revisionId],
            )
            .map((m) => [m.revisionId, memberDates[m.revisionId]]),
        ),
        skipRevisionIds: [...excluded],
      },
      `Applying ${includedCount} measure(s) and re-auditing…`,
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Badge variant="outline">New measure family</Badge>
          <span>{group.title}</span>
          <Badge variant="outline">
            {AUTHORITY_LABEL[group.authority] ?? group.authority}
          </Badge>
          <span className="font-normal text-muted-foreground">
            {group.members.length} code{group.members.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-h-80 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/80 text-left">
              <tr>
                <th className="w-8 px-2 py-1.5" />
                <th className="px-2 py-1.5 font-medium">Code</th>
                <th className="px-2 py-1.5 font-medium">Rate</th>
                <th className="px-2 py-1.5 font-medium">Countries</th>
                <th className="px-2 py-1.5 font-medium">Effective</th>
              </tr>
            </thead>
            <tbody>
              {group.members.map((m) => {
                const ex = m.extraction;
                const dateSuggestion =
                  !memberDates[m.revisionId] && ex?.effectiveDate.value
                    ? ex.effectiveDate
                    : null;
                return (
                  <tr
                    key={m.revisionId}
                    className={`border-t ${excluded.has(m.revisionId) ? "opacity-40" : ""}`}
                  >
                    <td className="px-2 py-1">
                      <Checkbox
                        checked={!excluded.has(m.revisionId)}
                        disabled={busy}
                        onCheckedChange={(v) =>
                          setExcluded((prev) => {
                            const next = new Set(prev);
                            if (v === true) next.delete(m.revisionId);
                            else next.add(m.revisionId);
                            return next;
                          })
                        }
                        aria-label={`Include ${m.ch99Code}`}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono">
                      {m.ch99Code}
                    </td>
                    <td
                      className="max-w-40 truncate px-2 py-1 font-mono"
                      title={m.rate === null && !m.exemption ? (m.rateText ?? undefined) : undefined}
                    >
                      {memberRateLabel(m)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1">
                      {m.countriesExcluded?.length ? (
                        `all except ${m.countriesExcluded.join(", ")}`
                      ) : m.countries?.length ? (
                        m.countries.join(", ")
                      ) : m.extraction?.countries.value ? (
                        <span
                          className="text-muted-foreground"
                          title={m.extraction.countries.evidence ?? undefined}
                        >
                          all — suggested {m.extraction.countries.value.join(", ")} (
                          {Math.round(m.extraction.countries.confidence * 100)}%)
                        </span>
                      ) : (
                        "all"
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1">
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="date"
                          className="h-7 w-36 text-xs"
                          value={memberDates[m.revisionId] ?? ""}
                          disabled={busy || excluded.has(m.revisionId)}
                          aria-label={`Effective date for ${m.ch99Code}`}
                          onChange={(e) =>
                            setMemberDates((d) => ({
                              ...d,
                              [m.revisionId]: e.target.value,
                            }))
                          }
                        />
                        {dateSuggestion ? (
                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:underline"
                            disabled={busy}
                            title={dateSuggestion.evidence ?? undefined}
                            onClick={() =>
                              setMemberDates((d) => ({
                                ...d,
                                [m.revisionId]: dateSuggestion.value!,
                              }))
                            }
                          >
                            → {dateSuggestion.value} (
                            {Math.round(dateSuggestion.confidence * 100)}%)
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label className="text-xs">
              Default effective date (fills every blank row)
            </Label>
            <Input
              type="date"
              value={defaultEffectiveDate}
              disabled={busy}
              onChange={(e) => changeDefaultEffectiveDate(e.target.value)}
              className="w-44"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              Default end date (blank = open-ended)
            </Label>
            <Input
              type="date"
              value={defaultEndDate}
              disabled={busy}
              onChange={(e) => setDefaultEndDate(e.target.value)}
              className="w-44"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex gap-2">
            <Button size="sm" onClick={approve} disabled={busy || includedCount === 0}>
              <Check /> Approve &amp; apply {includedCount} code
              {includedCount === 1 ? "" : "s"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void decide({ action: "reject" }, "Rejecting…")}
            >
              <X /> Reject family
            </Button>
          </div>
          {excluded.size > 0 ? (
            <p className="text-xs text-muted-foreground">
              {excluded.size} unchecked code{excluded.size === 1 ? "" : "s"} will
              be rejected when you approve. (A rejected code re-stages if it
              still exists in USITC&rsquo;s next release.)
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
