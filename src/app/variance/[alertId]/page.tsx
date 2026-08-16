import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { DocumentRail } from "@/components/document-rail";
import { HtsCode } from "@/components/hts-code";
import { StatusBadge } from "@/components/status-badge";
import { AlertActions } from "@/components/variance/alert-actions";
import { VarianceNavCard } from "@/components/variance/variance-nav-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AiVarianceDetailView } from "@/components/variance/ai-variance-detail";
import {
  DUTY_CHARGE_TYPES,
  getAiVarianceDetail,
  getVarianceDetail,
} from "@/lib/db/queries/variance";
import {
  formatCents,
  formatDate,
  formatHts,
  formatMoney,
  formatRate,
} from "@/lib/format";
import {
  nextOpenSiblingId,
  pairSiblingAlerts,
  unitIds,
  unitStatus,
} from "@/lib/variance/grouping";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Issues whose money lives in the line's duty total — they light up the
// always-on Duty row with an expected total (declared − impact).
const DUTY_ISSUE_TYPES = new Set([
  "rate_mismatch",
  "amount_mismatch",
  "missing_measure",
  "unexpected_measure",
]);

// Measure names in the tariff reference read like "Section 301 List 3 —
// China" or "IEEPA Reciprocal Tariff — baseline"; the Field column wants
// the authority alone.
function shortMeasureName(name: string): string {
  const section = name.match(/^Section\s+\d+/i);
  if (section) return section[0];
  if (/IEEPA/i.test(name)) return "IEEPA";
  return name.split("—")[0].trim();
}

function ImpactText({
  impactCents,
  direction,
  className,
}: {
  impactCents: number | null;
  direction: "recoverable" | "exposure" | null;
  className?: string;
}) {
  if (impactCents === null)
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        direction === "recoverable" && "text-emerald-700 dark:text-emerald-400",
        direction === "exposure" && "text-red-700 dark:text-red-400",
        direction === null && "text-muted-foreground",
      )}
      title={
        direction === "recoverable"
          ? "Overpaid: recoverable"
          : direction === "exposure"
            ? "Underpaid: exposure"
            : undefined
      }
    >
      {direction === "recoverable" ? "+" : direction === "exposure" ? "−" : ""}
      {formatCents(Math.abs(impactCents))}
      {direction ? (
        <span className="ml-1 font-normal text-muted-foreground">
          {direction === "recoverable" ? "recoverable" : "exposure"}
        </span>
      ) : null}
    </span>
  );
}

type DiffRow = {
  /** Unique per row — field names repeat across issues (e.g. one Measure
   *  row per missing/unexpected measure). */
  key: string;
  field: string;
  expected: React.ReactNode;
  filed: React.ReactNode;
  /** The running ledger: the row's final value once its issue is decided —
   *  the Expected side when accepted, the Filed side when dismissed.
   *  Undefined (rendered "—") while open, and always for context rows. */
  corrected?: React.ReactNode;
  /** The issue this row belongs to; context rows carry none. Drives the
   *  row's status coloring and the current-issue amber highlight. */
  issue?: { status: "open" | "resolved" | "dismissed"; current: boolean };
};

export default async function VarianceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ alertId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { alertId } = await params;
  // ?from=entry marks a review flow entered from the entry page: in-flow
  // navigation carries it along, and both "done" and browser-back land on
  // the entry rather than the variance queue.
  const fromEntry = (await searchParams).from === "entry";
  const detail = await getVarianceDetail(alertId);
  if (!detail) {
    // Not an audit alert: the id may be an AI analysis finding — same
    // route, so mixed lines hop between rule and AI issues seamlessly.
    const ai = await getAiVarianceDetail(alertId);
    if (!ai) notFound();
    if (ai.finding.lineItemId === null) redirect(`/entries/${ai.entry.id}`);
    return <AiVarianceDetailView detail={ai} fromEntry={fromEntry} />;
  }
  // Entry-scoped variances (no line) reconcile on the entry page itself.
  if (detail.alert.lineItemId === null) redirect(`/entries/${detail.entry.id}`);

  const {
    alert,
    entry,
    window,
    line,
    catalogExpected,
    documents,
    invoices,
    siblings,
  } = detail;
  // Decisions operate on UNITS: a rate mismatch and its duty-amount twin
  // decide together (pairSiblingAlerts) — advance, undo, and the completion
  // summary all count units, and a unit's primary page is where links land.
  const units = pairSiblingAlerts(siblings);
  const unitRows = units.map((u) => ({
    id: u.primary.id,
    ids: unitIds(u),
    status: unitStatus(u),
    // A unit's decision moment: the latest member stamp (twins decide
    // together; either carries it). 0 while open or for legacy rows.
    decidedAt: Math.max(
      0,
      ...[u.primary, u.consequence]
        .filter((m) => m !== null)
        .map((m) => m.resolvedAt?.getTime() ?? 0),
    ),
  }));
  const currentUnit = unitRows.find((u) => u.ids.includes(alert.id)) ?? null;
  const decideIds = currentUnit?.ids ?? [alert.id];
  const nextOpenAlertId = nextOpenSiblingId(
    unitRows,
    currentUnit?.id ?? alert.id,
  );
  // Inline Undo target: the line's most recently decided unit — "the one I
  // just accepted/dismissed" — regardless of where it re-sorted in card
  // order. Card position won't do: the decided band sorts canonically (by
  // impact), not chronologically.
  const undoPrevious = unitRows
    .filter((u) => u.status !== "open" && !u.ids.includes(alert.id))
    .reduce<{ ids: string[]; backTo: string; decidedAt: number } | null>(
      (best, u) =>
        best === null || u.decidedAt > best.decidedAt
          ? { ids: u.ids, backTo: u.id, decidedAt: u.decidedAt }
          : best,
      null,
    );
  const d = alert.details ?? {};
  const str = (k: string) =>
    typeof d[k] === "string" ? (d[k] as string) : null;

  const muted = (text: string) => (
    <span className="text-muted-foreground">{text}</span>
  );
  const amber = (node: React.ReactNode) => (
    <span className="text-amber-700 dark:text-amber-400">{node}</span>
  );

  // ------------------------------------------------- the field-level diff
  //
  // The table is the whole line's ledger: EVERY issue's diff rows render at
  // once, each colored by its issue's status — green when accepted (the
  // Expected side stays, as the accepted answer), muted and struck-through
  // when dismissed — while amber marks only what the CURRENT issue puts in
  // question. Context rows (the filed facts) never color.
  const rows: DiffRow[] = [];
  const declaredHts = line?.htsCode ?? str("actual_hts");

  type UnitCtx = {
    id: string;
    type: string;
    alertKey: string;
    tag: { status: "open" | "resolved" | "dismissed"; current: boolean };
    dStr: (k: string) => string | null;
    dNum: (k: string) => number | null;
    details: Record<string, unknown>;
    impact: {
      impactCents: number | null;
      direction: "recoverable" | "exposure" | null;
    };
  };
  const unitCtxs: UnitCtx[] = units.map((u) => {
    const det = u.primary.details ?? {};
    return {
      id: u.primary.id,
      type: u.primary.alertType,
      alertKey: u.primary.alertKey,
      tag: {
        status: unitStatus(u),
        current: unitIds(u).includes(alert.id),
      },
      details: det,
      dStr: (k) => (typeof det[k] === "string" ? (det[k] as string) : null),
      dNum: (k) => (typeof det[k] === "number" ? (det[k] as number) : null),
      impact: {
        impactCents:
          u.primary.impactCents ?? u.consequence?.impactCents ?? null,
        direction:
          u.primary.impactCents !== null
            ? u.primary.direction
            : (u.consequence?.direction ?? null),
      },
    };
  });

  // Where an expectation comes from, derived from the alert's own evidence
  // fields — invoice numbers and vendor names when the details carry them,
  // the comparison basis by rule family otherwise. Never hardcoded per row.
  const sourceLabel = (c: UnitCtx): string | null => {
    const invoiceNumbers = Array.isArray(c.details.invoice_numbers)
      ? (c.details.invoice_numbers as unknown[]).filter(
          (n): n is string => typeof n === "string",
        )
      : [];
    if (c.dStr("invoice_number") || invoiceNumbers.length > 0) {
      return "Source: Invoice";
    }
    // Vendor sourcing IS catalog data (the part's vendor sources).
    if (c.dStr("vendor_name")) return "Source: Catalog";
    switch (c.type) {
      case "hts_discrepancy":
      case "hts_reclassified":
      case "coo_discrepancy":
        return "Source: Catalog";
      // Ch.99 measures and official rates live in the Harmonized Tariff
      // Schedule reference data.
      case "rate_mismatch":
      case "amount_mismatch":
      case "missing_measure":
      case "unexpected_measure":
        return "Source: Schedule";
      default:
        return c.type.startsWith("ai_") ? "Source: AI analyst" : null;
    }
  };
  // Citations sit right-aligned in the Expected column and click through to
  // the evidence where a destination exists: Invoice opens the matching
  // document on file, Catalog opens the Parts page filtered to the SKU
  // (there is no per-SKU page yet — the filtered catalog stands in, same as
  // the events feed's SKU scoping). Schedule has no page yet (a
  // customer-facing tariff-schedule view comes later), so it stays plain
  // text — no underline, not clickable.
  const normalizeRef = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sourceHref = (c: UnitCtx, label: string): string | null => {
    if (label === "Source: Invoice") {
      const nums = [
        ...(Array.isArray(c.details.invoice_numbers)
          ? (c.details.invoice_numbers as unknown[]).filter(
              (n): n is string => typeof n === "string",
            )
          : []),
        ...(c.dStr("invoice_number") ? [c.dStr("invoice_number")!] : []),
      ].map(normalizeRef);
      const invoiceDocs = documents.filter(
        (doc) => doc.docType === "commercial_invoice",
      );
      const match =
        invoiceDocs.find((doc) => {
          const fn = normalizeRef(doc.fileName);
          return nums.some((n) => n.length > 0 && fn.includes(n));
        }) ?? (invoiceDocs.length === 1 ? invoiceDocs[0] : null);
      return match
        ? `/api/documents/${match.id}/file?disposition=inline`
        : null;
    }
    if (label === "Source: Catalog") {
      const sku = line?.sku ?? c.dStr("sku");
      return sku ? `/parts?sku=${encodeURIComponent(sku)}` : null;
    }
    return null;
  };
  const sourceCite = (c: UnitCtx): React.ReactNode => {
    const label = sourceLabel(c);
    if (!label) return null;
    const href = sourceHref(c, label);
    const cls =
      "shrink-0 whitespace-nowrap text-xs font-normal text-muted-foreground";
    if (!href) return <span className={cls}>{label}</span>;
    // Documents open in the browser; app pages navigate in place.
    return href.startsWith("/api/") ? (
      <a
        href={href}
        target="_blank"
        rel="noopener"
        className={cn(cls, "hover:underline")}
      >
        {label}
      </a>
    ) : (
      <Link href={href} className={cn(cls, "hover:underline")}>
        {label}
      </Link>
    );
  };
  // Financial deltas live as a small line under the Expected figure.
  const impactNote = (c: UnitCtx): React.ReactNode =>
    c.impact.impactCents !== null ? (
      <span className="block text-xs font-normal">
        <ImpactText {...c.impact} />
      </span>
    ) : null;
  // The ledger value once the row's issue is decided.
  const corrected = (
    tag: DiffRow["issue"],
    acceptedNode: React.ReactNode,
    dismissedNode: React.ReactNode,
  ): React.ReactNode | undefined =>
    tag?.status === "resolved"
      ? acceptedNode
      : tag?.status === "dismissed"
        ? dismissedNode
        : undefined;

  // The Expected column is the world under the expected classification all
  // the way down — rate and computed duty included — so the counterfactual
  // stack renders as diff rows, not a separate card.
  const declaredBaseRateStr =
    line?.charges.find((c) => c.chargeType === "base_duty")?.rate ?? null;
  const expectedStackSummary = catalogExpected
    ? [
        catalogExpected.baseDuty
          ? catalogExpected.baseDuty.rate === 0
            ? "free base"
            : `base ${formatRate(catalogExpected.baseDuty.rate)}`
          : null,
        ...catalogExpected.measures.map(
          (m) => `${shortMeasureName(m.name)} ${formatRate(m.rate)}`,
        ),
      ]
        .filter(Boolean)
        .join(" + ")
    : null;

  const catalogDutyRows = (c: UnitCtx): DiffRow[] => {
    if (!catalogExpected) return [];
    const out: DiffRow[] = [];
    const expRate = catalogExpected.baseDuty?.rate ?? null;
    if (expRate !== null) {
      const decRate =
        declaredBaseRateStr === null ? null : Number(declaredBaseRateStr);
      const pts =
        decRate === null ? null : Math.round((decRate - expRate) * 10000) / 100;
      const tag = pts !== null && pts !== 0 ? c.tag : undefined;
      out.push({
        key: `duty-rate:${c.id}`,
        field: "Duty rate",
        expected: (
          <div className="flex items-start justify-between gap-3">
            <span className="tabular-nums">{formatRate(expRate)}</span>
            {sourceCite(c)}
          </div>
        ),
        filed:
          decRate === null ? (
            muted("none declared")
          ) : pts !== 0 ? (
            amber(<span className="tabular-nums">{formatRate(decRate)}</span>)
          ) : (
            <span className="tabular-nums">{formatRate(decRate)}</span>
          ),
        corrected: corrected(
          tag,
          <span className="tabular-nums">{formatRate(expRate)}</span>,
          decRate === null ? (
            muted("none declared")
          ) : (
            <span className="tabular-nums">{formatRate(decRate)}</span>
          ),
        ),
        issue: tag,
      });
    }
    if (
      catalogExpected.totalCents !== null &&
      catalogExpected.declaredDutyCents !== null
    ) {
      out.push({
        key: `duty:${c.id}`,
        field: "Duty",
        expected: (
          <span className="tabular-nums">
            {formatCents(catalogExpected.totalCents)}
            {expectedStackSummary ? (
              <span className="block text-xs font-normal text-muted-foreground">
                {expectedStackSummary}
              </span>
            ) : null}
            {impactNote(c)}
          </span>
        ),
        filed: (
          <span className="tabular-nums">
            {formatCents(catalogExpected.declaredDutyCents)}
          </span>
        ),
        corrected: corrected(
          c.tag,
          <span className="tabular-nums">
            {formatCents(catalogExpected.totalCents)}
          </span>,
          <span className="tabular-nums">
            {formatCents(catalogExpected.declaredDutyCents)}
          </span>,
        ),
        issue: c.tag,
      });
    }
    return out;
  };

  // --- HTS: one row per classification issue; a context row when none.
  const htsUnits = unitCtxs.filter((c) =>
    ["invoice_hts_mismatch", "hts_discrepancy", "hts_reclassified"].includes(
      c.type,
    ),
  );
  for (const c of htsUnits) {
    if (c.type === "invoice_hts_mismatch") {
      const invoiceHts = c.dStr("expected_hts");
      if (!declaredHts || !invoiceHts) continue;
      rows.push({
        key: `hts:${c.id}`,
        field: "HTS",
        expected: (
          <div className="flex items-start justify-between gap-3">
            <HtsCode code={invoiceHts} />
            {sourceCite(c)}
          </div>
        ),
        filed: <HtsCode code={declaredHts} compareTo={invoiceHts} />,
        corrected: corrected(
          c.tag,
          <HtsCode code={invoiceHts} />,
          <HtsCode code={declaredHts} />,
        ),
        issue: c.tag,
      });
    } else if (c.type === "hts_discrepancy") {
      const catalogHts = line?.catalogHtsCode ?? c.dStr("expected_hts");
      if (!declaredHts || !catalogHts) continue;
      rows.push({
        key: `hts:${c.id}`,
        field: "HTS",
        expected: (
          <div className="flex items-start justify-between gap-3">
            <HtsCode code={catalogHts} />
            {sourceCite(c)}
          </div>
        ),
        filed: <HtsCode code={declaredHts} compareTo={catalogHts} />,
        corrected: corrected(
          c.tag,
          <HtsCode code={catalogHts} />,
          <HtsCode code={declaredHts} />,
        ),
        issue: c.tag,
      });
    } else {
      // Filed matched its day's catalog; the diff is against TODAY's
      // classification — the retroactive-correction counterfactual.
      const currentHts =
        line?.catalogHtsCodeCurrent ?? c.dStr("expected_hts_current");
      if (!declaredHts || !currentHts) continue;
      rows.push({
        key: `hts:${c.id}`,
        field: "HTS",
        expected: (
          <div className="flex items-start justify-between gap-3">
            <HtsCode code={currentHts} />
            {sourceCite(c)}
          </div>
        ),
        filed: (
          // The filing wasn't an error — it matched the catalog on its day;
          // the world changed afterward. That's what makes this issue a
          // refund lead rather than a mistake.
          <span>
            <HtsCode code={declaredHts} compareTo={currentHts} />
            <span className="block text-xs font-normal text-muted-foreground">
              matched catalog at filing
            </span>
          </span>
        ),
        corrected: corrected(
          c.tag,
          <HtsCode code={currentHts} />,
          <HtsCode code={declaredHts} />,
        ),
        issue: c.tag,
      });
    }
  }
  if (rows.length === 0 && declaredHts) {
    rows.push({
      key: "ctx-hts",
      field: "HTS",
      expected: muted("—"),
      filed: <HtsCode code={declaredHts} />,
    });
  }

  // --- Duty rates, measures, and the line's duty total. The catalog HTS
  // issue brings its own counterfactual pair; otherwise the always-on Duty
  // row is lit by the current duty-touching issue (or the worst one with
  // dollars) — simultaneous corrections overlap, so it carries one story.
  const htsDutyUnit =
    htsUnits.find((c) => c.type !== "invoice_hts_mismatch") ?? null;
  const catalogPair =
    htsDutyUnit && catalogExpected ? catalogDutyRows(htsDutyUnit) : [];
  rows.push(...catalogPair);

  const dutyUnits = unitCtxs.filter((c) => DUTY_ISSUE_TYPES.has(c.type));

  // Declared measures that raised no issue render as context rows, named in
  // the Field column — so the measure picture is complete and "filed vs.
  // not" reads directly off the table. Charges already claimed by an issue
  // row (an unexpected measure, or the charge a rate/amount pair targets)
  // are skipped: those rows tell the story.
  if (line) {
    const issueChargeDigits = new Set(
      dutyUnits
        .map((c) =>
          c.type === "unexpected_measure"
            ? (c.dStr("actual_hts") ?? "").replace(/\D/g, "")
            : c.type === "rate_mismatch" || c.type === "amount_mismatch"
              ? c.alertKey.slice(c.alertKey.lastIndexOf(":") + 1)
              : "",
        )
        .filter((digits) => /^\d+$/.test(digits)),
    );
    for (const ch of line.charges) {
      if (!DUTY_CHARGE_TYPES.has(ch.chargeType)) continue;
      if (ch.chargeType === "base_duty") continue;
      const digits = (ch.htsCode ?? "").replace(/\D/g, "");
      if (digits && issueChargeDigits.has(digits)) continue;
      rows.push({
        key: `measure-declared:${ch.id}`,
        field: shortMeasureName(
          ch.measureName ??
            (ch.htsCode ? formatHts(ch.htsCode) : "Additional duty"),
        ),
        filed: (
          <span className="inline-flex items-center gap-1.5">
            <span className="tabular-nums">
              {formatMoney(Number(ch.amount))}
            </span>
            {ch.rate !== null ? (
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                at {formatRate(Number(ch.rate))}
              </span>
            ) : null}
          </span>
        ),
        expected: muted("—"),
      });
    }
  }

  for (const c of dutyUnits) {
    if (c.type === "rate_mismatch") {
      const expectedRate = c.dNum("expected_rate");
      const actualRate = c.dNum("actual_rate");
      rows.push({
        key: `duty-rate:${c.id}`,
        field: "Duty rate",
        expected: (
          <div className="flex items-start justify-between gap-3">
            <span className="tabular-nums">{formatRate(expectedRate)}</span>
            {sourceCite(c)}
          </div>
        ),
        filed: amber(
          <span className="tabular-nums">{formatRate(actualRate)}</span>,
        ),
        corrected: corrected(
          c.tag,
          <span className="tabular-nums">{formatRate(expectedRate)}</span>,
          <span className="tabular-nums">{formatRate(actualRate)}</span>,
        ),
        issue: c.tag,
      });
    }
    if (c.type === "missing_measure") {
      const expectedAmountNode = (
        <span className="tabular-nums">
          {formatMoney(c.dNum("expected_amount"))}
        </span>
      );
      rows.push({
        key: `measure:${c.id}`,
        field: shortMeasureName(c.dStr("measure_name") ?? "Base duty"),
        expected: (
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex items-center gap-1.5">
              {expectedAmountNode}
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                at {formatRate(c.dNum("expected_rate"))}
              </span>
            </span>
            {sourceCite(c)}
          </div>
        ),
        filed: amber("not declared"),
        corrected: corrected(c.tag, expectedAmountNode, muted("not declared")),
        issue: c.tag,
      });
    }
    if (c.type === "unexpected_measure") {
      const filedAmountNode = (
        <span className="tabular-nums">
          {formatMoney(c.dNum("actual_amount"))}
        </span>
      );
      rows.push({
        key: `measure:${c.id}`,
        field: shortMeasureName(c.dStr("measure_name") ?? "Measure"),
        expected: (
          <div className="flex items-start justify-between gap-3">
            <span>
              {muted("not expected")}
              {!c.dStr("stacking_reason") ? (
                <span className="block text-xs font-normal text-muted-foreground">
                  possible coverage gap; review
                </span>
              ) : null}
            </span>
            {sourceCite(c)}
          </div>
        ),
        filed: amber(filedAmountNode),
        corrected: corrected(c.tag, muted("not expected"), filedAmountNode),
        issue: c.tag,
      });
    }
  }
  if (line && catalogPair.length === 0) {
    const declaredCents = line.charges
      .filter((c) => DUTY_CHARGE_TYPES.has(c.chargeType))
      .reduce((sum, c) => sum + Math.round(Number(c.amount) * 100), 0);
    const hasCharges = line.charges.length > 0;
    // Duty-touching issues STACK into the one total: every unit with dollars
    // contributes. Accepted impacts land in Corrected immediately; open ones
    // keep the row in question (amber) with the potential net underneath;
    // dismissed findings drop out of the math.
    const impactUnits = dutyUnits.filter((c) => c.impact.impactCents !== null);
    const sumImpact = (us: UnitCtx[]) =>
      us.reduce((s, c) => s + (c.impact.impactCents ?? 0), 0);
    const acceptedUnits = impactUnits.filter(
      (c) => c.tag.status === "resolved",
    );
    const openUnits = impactUnits.filter((c) => c.tag.status === "open");
    const activeUnits = impactUnits.filter(
      (c) => c.tag.status !== "dismissed",
    );
    // The expectation ignores dismissed findings — unless everything was
    // dismissed, where the struck-through column keeps the original claim.
    const expectationUnits = activeUnits.length > 0 ? activeUnits : impactUnits;
    const expectedTotal =
      expectationUnits.length > 0
        ? declaredCents - sumImpact(expectationUnits)
        : null;
    const correctedSoFar = declaredCents - sumImpact(acceptedUnits);
    const netPotential = correctedSoFar - sumImpact(openUnits);
    const tag: DiffRow["issue"] =
      impactUnits.length === 0
        ? undefined
        : {
            status:
              openUnits.length > 0
                ? "open"
                : acceptedUnits.length > 0
                  ? "resolved"
                  : "dismissed",
            // Amber when the reviewer is ON one of these issues, and once a
            // partial stack exists — accepted + still-open = in question.
            current:
              impactUnits.some((c) => c.tag.current) ||
              (acceptedUnits.length > 0 && openUnits.length > 0),
          };
    const filedTotalNode = !hasCharges ? (
      muted("none declared")
    ) : (
      <span className="tabular-nums">{formatCents(declaredCents)}</span>
    );
    rows.push({
      key: "duty-total",
      field: "Duty",
      expected:
        expectedTotal !== null ? (
          <span className="tabular-nums">
            {formatCents(expectedTotal)}
            {expectationUnits.map((c) => (
              <span key={c.id} className="block text-xs font-normal">
                <ImpactText {...c.impact} />
              </span>
            ))}
          </span>
        ) : (
          muted("—")
        ),
      filed: !hasCharges ? (
        muted("none declared")
      ) : impactUnits.length > 0 ? (
        amber(
          <span className="tabular-nums">{formatCents(declaredCents)}</span>,
        )
      ) : (
        <span className="tabular-nums">{formatCents(declaredCents)}</span>
      ),
      corrected:
        acceptedUnits.length > 0 ? (
          <span className="tabular-nums">
            {formatCents(correctedSoFar)}
            {openUnits.length > 0 ? (
              <span className="block text-xs font-normal text-amber-700 dark:text-amber-400">
                Net {formatCents(netPotential)} if remaining accepted
              </span>
            ) : acceptedUnits.length > 1 ? (
              <span className="block text-xs font-normal text-muted-foreground">
                net of {acceptedUnits.length} corrections
              </span>
            ) : null}
          </span>
        ) : tag?.status === "dismissed" ? (
          filedTotalNode
        ) : undefined,
      issue: tag,
    });
  }

  // --- Origin: one row per origin issue (each names its evidence source);
  // a context row when none.
  const cooUnits = unitCtxs.filter((c) => c.type === "coo_discrepancy");
  for (const c of cooUnits) {
    // The same alertType serves two evidence sources — an invoice_number in
    // details marks a CI-vs-entry finding, otherwise it's the catalog rule —
    // and srcNote derives the citation from whichever fields are present.
    const expectedCoo =
      c.dStr("expected_coo") ??
      (Array.isArray(c.details.expected_coos)
        ? (c.details.expected_coos as string[]).join(" / ")
        : null);
    const declaredCoo = c.dStr("declared_coo") ?? line?.countryOfOrigin ?? "—";
    rows.push({
      key: `origin:${c.id}`,
      field: "Origin",
      expected: (
        <div className="flex items-start justify-between gap-3">
          <span className="tabular-nums">{expectedCoo ?? "—"}</span>
          {sourceCite(c)}
        </div>
      ),
      filed: amber(declaredCoo),
      corrected: corrected(
        c.tag,
        <span className="tabular-nums">{expectedCoo ?? "—"}</span>,
        <span className="tabular-nums">{declaredCoo}</span>,
      ),
      issue: c.tag,
    });
  }
  if (cooUnits.length === 0 && line?.countryOfOrigin) {
    rows.push({
      key: "ctx-origin",
      field: "Origin",
      expected: muted("—"),
      filed: <span className="tabular-nums">{line.countryOfOrigin}</span>,
    });
  }

  // --- CI-vs-entry findings: the invoice side is "expected", the 7501
  // "filed".
  const quantityUnits = unitCtxs.filter(
    (c) => c.type === "quantity_discrepancy",
  );
  for (const c of unitCtxs) {
    if (
      c.type === "value_mismatch" &&
      c.dNum("expected_amount") !== null &&
      c.dStr("sku") !== null
    ) {
      rows.push({
        key: `value:${c.id}`,
        field: "Value",
        expected: (
          <div className="flex items-start justify-between gap-3">
            <span className="tabular-nums">
              {formatMoney(c.dNum("expected_amount"))}
              {impactNote(c)}
            </span>
            {sourceCite(c)}
          </div>
        ),
        filed: amber(
          <span className="tabular-nums">
            {formatMoney(c.dNum("actual_amount"))}
          </span>,
        ),
        corrected: corrected(
          c.tag,
          <span className="tabular-nums">
            {formatMoney(c.dNum("expected_amount"))}
          </span>,
          <span className="tabular-nums">
            {formatMoney(c.dNum("actual_amount"))}
          </span>,
        ),
        issue: c.tag,
      });
    }
    if (c.type === "quantity_discrepancy") {
      rows.push({
        key: `quantity:${c.id}`,
        field: "Quantity",
        expected: (
          <div className="flex items-start justify-between gap-3">
            <span className="tabular-nums">
              {c.dNum("expected_quantity") ?? "—"}
            </span>
            {sourceCite(c)}
          </div>
        ),
        filed: amber(
          <span className="tabular-nums">
            {c.dNum("actual_quantity") ?? "—"}
          </span>,
        ),
        corrected: corrected(
          c.tag,
          <span className="tabular-nums">
            {c.dNum("expected_quantity") ?? "—"}
          </span>,
          <span className="tabular-nums">
            {c.dNum("actual_quantity") ?? "—"}
          </span>,
        ),
        issue: c.tag,
      });
    }
    // AI findings carry their own filed-vs-expected rows (finding.fields)
    // — they join the same ledger, colored by their issue's status like
    // every other unit.
    if (c.type.startsWith("ai_")) {
      const aiFields = Array.isArray(c.details.fields)
        ? (c.details.fields as {
            field: string;
            filed: string | null;
            expected: string | null;
          }[])
        : [];
      aiFields.forEach((f, i) => {
        rows.push({
          key: `ai:${c.id}:${i}`,
          field: f.field,
          expected: (
            <div className="flex items-start justify-between gap-3">
              <span className="tabular-nums">
                {f.expected ?? muted("—")}
              </span>
              {i === 0 ? sourceCite(c) : null}
            </div>
          ),
          filed: amber(
            <span className="tabular-nums">{f.filed ?? "—"}</span>,
          ),
          corrected: corrected(
            c.tag,
            <span className="tabular-nums">{f.expected ?? "—"}</span>,
            <span className="tabular-nums">{f.filed ?? "—"}</span>,
          ),
          issue: c.tag,
        });
      });
    }
    if (c.type === "invoice_sku_missing") {
      rows.push({
        key: `coverage:${c.id}`,
        field: "Invoice coverage",
        expected: (
          <div className="flex items-start justify-between gap-3">
            <span>
              {muted("listed on a linked invoice")}
              <span className="block text-xs font-normal text-muted-foreground">
                possible ingestion gap; review
              </span>
            </span>
            {sourceCite(c)}
          </div>
        ),
        filed: amber("not on any linked invoice"),
        corrected: corrected(
          c.tag,
          muted("on invoice"),
          muted("not on invoice"),
        ),
        issue: c.tag,
      });
    }
  }

  // --- Always-on filed facts.
  if (line) {
    rows.push(
      {
        key: "ctx-entered-value",
        field: "Entered value",
        expected: muted("—"),
        filed: (
          <span className="tabular-nums">{formatMoney(line.enteredValue)}</span>
        ),
      },
      // A quantity issue already renders its own Quantity diff row.
      ...(quantityUnits.length === 0
        ? [
            {
              key: "ctx-quantity",
              field: "Quantity",
              expected: muted("—"),
              filed: (
                <span className="tabular-nums">
                  {line.quantity ? Number(line.quantity) : "—"}
                </span>
              ),
            } satisfies DiffRow,
          ]
        : []),
      {
        key: "ctx-supplier",
        field: "Supplier",
        expected: muted("—"),
        filed: <span>{line.supplierName ?? "—"}</span>,
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href={fromEntry ? `/entries/${entry.id}` : "/variance"}>
            <ArrowLeft />{" "}
            {fromEntry
              ? `Back to entry ${entry.entryNumber}`
              : "Back to variance"}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {alert.label}
          </h1>
          <StatusBadge status={alert.alertType} />
          {alert.status !== "open" ? (
            <Badge variant="secondary" className="font-normal">
              {alert.status === "resolved" ? "accepted" : alert.status}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          <Link
            href={`/entries/${entry.id}`}
            className="tabular-nums hover:underline"
          >
            Entry {entry.entryNumber}
          </Link>
          {line ? ` · line ${line.lineNumber}` : ""}
          {line?.sku ? ` · ${line.sku}` : ""}
          {entry.entryDate ? ` · filed ${formatDate(entry.entryDate)}` : ""}
          {window.phase === "liquidated"
            ? " · liquidated"
            : window.phase === "unsubmitted" && window.nextPhaseDate
              ? ` · unsubmitted · editable without PSC until ${formatDate(window.nextPhaseDate)}`
              : window.nextPhaseDate
                ? ` · submitted · est. liquidation ${formatDate(window.nextPhaseDate)} · ${window.daysLeft}d left`
                : ""}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">
            <Table className="[&_td]:py-3.5">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Field</TableHead>
                  <TableHead className="border-l">Filed</TableHead>
                  <TableHead className="border-l">Expected</TableHead>
                  <TableHead className="border-l">Corrected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Every issue's rows render at once, colored by THAT
                    issue's status. Accepted: green row, Filed struck, the
                    Expected answer lands in the Corrected ledger. Dismissed:
                    muted row, Expected struck, the Filed value stands in the
                    ledger. Amber marks only the current issue's rows; the
                    ledger stays "—" while a row is undecided. Rows with no
                    issue carry their Filed value straight into the ledger —
                    once every issue is decided, Corrected reads as the full
                    line ready for filing. */}
                {rows.map((row) => (
                  <TableRow
                    key={row.key}
                    className={cn(
                      row.issue?.current &&
                        row.issue.status === "open" &&
                        "bg-amber-50/50 dark:bg-amber-950/20",
                      row.issue?.status === "resolved" &&
                        "bg-emerald-50/50 dark:bg-emerald-950/20",
                      row.issue?.status === "dismissed" && "bg-muted",
                    )}
                  >
                    <TableCell className="text-muted-foreground">
                      {row.field}
                    </TableCell>
                    {/* The strike must be set on descendants too — inline-flex
                        wrappers are atomic boxes that cell-level
                        text-decoration cannot reach. */}
                    <TableCell
                      className={cn(
                        "border-l font-medium",
                        row.issue?.status === "resolved" &&
                          "line-through [&_*]:line-through",
                      )}
                    >
                      {row.filed}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "border-l font-medium",
                        row.issue?.status === "dismissed" &&
                          "line-through [&_*]:line-through",
                      )}
                    >
                      {row.expected}
                    </TableCell>
                    <TableCell className="border-l font-medium">
                      {row.corrected ?? (row.issue ? muted("—") : row.filed)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!line ? (
            <p className="mt-3 text-sm text-muted-foreground">
              The flagged line was re-ingested and no longer exists; showing
              the facts the alert recorded when it fired.
            </p>
          ) : null}
          <div className="mt-4">
            <AlertActions
              alertId={alert.id}
              status={alert.status}
              alertType={alert.alertType}
              partId={alert.partId}
              entryId={entry.id}
              fromEntry={fromEntry}
              decideIds={decideIds}
              nextOpenAlertId={nextOpenAlertId}
              undoPrevious={undoPrevious}
              lineUnits={unitRows.map((u) => ({
                ids: u.ids,
                status: u.status,
              }))}
            />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <VarianceNavCard
            siblings={siblings}
            currentId={alert.id}
            fromEntry={fromEntry}
          />

          {invoices.map((inv) => (
            <Card key={inv.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  Invoice {inv.invoiceNumber}
                </CardTitle>
                <CardDescription>
                  {inv.supplierName ?? "Unknown supplier"}
                  {inv.invoiceDate ? ` · ${formatDate(inv.invoiceDate)}` : ""}
                  {inv.totalAmount
                    ? ` · ${formatMoney(Number(inv.totalAmount))} ${inv.currency}`
                    : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>HTS</TableHead>
                      <TableHead>COO</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inv.lines.map((li) => (
                      <TableRow
                        key={li.lineNumber}
                        className={cn(
                          li.sku !== null &&
                            li.sku === str("sku") &&
                            "bg-amber-50/50 dark:bg-amber-950/20",
                        )}
                      >
                        <TableCell className="font-medium">
                          {li.sku ?? "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {li.htsCode ? formatHts(li.htsCode) : "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {li.countryOfOrigin ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {li.quantity ? Number(li.quantity) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(Number(li.totalPrice))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documents on file</CardTitle>
            </CardHeader>
            <CardContent>
              {documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No documents linked to this entry yet.
                </p>
              ) : (
                <DocumentRail documents={documents} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
