import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { getReferenceDataForOrg } from "./reference";
import { resolveSailInfo } from "@/lib/duty/sail";
import type { SailInfo } from "@/lib/duty/types";
import { resolveWindow } from "@/lib/effective-dating";
import { deriveEntryStatus } from "@/lib/entries/status";
import {
  computeAlertImpact,
  computeCatalogExpected,
  expectedTotalCents,
  type AlertImpact,
  type ImpactContext,
  type ImpactLineSnapshot,
} from "@/lib/variance/impact";
import { compareSiblingAlerts } from "@/lib/variance/grouping";
import {
  liquidationWindow,
  type LiquidationWindow,
} from "@/lib/variance/window";
import {
  getEntryDetail,
  type AiFindingRow,
  type EntryDetail,
  type EntryDocument,
  type LineItemDetail,
} from "./entries";

// Read-only projections over audit_alerts AND analysis_findings for the
// Variance queue and the line-reconciliation pages. Impact and windows are
// derived on read (never stored); the auditor stays the sole writer of the
// alerts and analysis/service.ts of the findings. AI rows join the queue
// under alertType "ai_<category>" — same grouping, filters, and decisions
// as rule rows — with two deliberate differences: only NOVEL findings
// enter (a corroboration's issue is already a rule row), and impact stays
// null (the deterministic engine owns money math; the analyst only cites
// it).

export const DUTY_CHARGE_TYPES = new Set([
  "base_duty",
  "additional_duty",
  "antidumping",
  "countervailing",
]);

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
const todayIso = () => new Date().toISOString().slice(0, 10);

const detailsOf = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;

type SnapshotPart = {
  status: string;
  classifications: {
    htsCode: string;
    validFrom: string | null;
    validTo: string | null;
  }[];
} | null;

/** The part's committed catalog code as of a date (windows hold committed
 *  codes only, so the provisional guard is implicit); null for draft parts —
 *  mirrors the auditor's guards. */
function catalogCodeAsOf(part: SnapshotPart, asOf: string | null): string | null {
  if (!part || part.status === "draft") return null;
  return resolveWindow(part.classifications, asOf)?.htsCode ?? null;
}

/** Impact inputs from the alert's line-item graph row; null when the line
 *  was re-ingested away. Catalog codes resolve as of the entry date (the
 *  governing expectation) plus the current window (the reclassified
 *  counterfactual). */
function snapshotOf(
  li: {
    htsCodeDigits: string;
    countryOfOrigin: string | null;
    enteredValue: string;
    part: SnapshotPart;
    charges: { chargeType: string; amount: string }[];
  } | null,
  entryDate: string | null,
): ImpactLineSnapshot | null {
  if (!li) return null;
  const catalog = catalogCodeAsOf(li.part, entryDate);
  const catalogCurrent = catalogCodeAsOf(li.part, null);
  const catalogDigits = catalog ? catalog.replace(/\D/g, "") : null;
  return {
    htsCodeDigits: li.htsCodeDigits,
    countryOfOrigin: li.countryOfOrigin,
    enteredValueCents: Math.round(Number(li.enteredValue) * 100),
    catalogHtsDigits: catalogDigits,
    catalogHtsDigitsCurrent: catalogCurrent
      ? catalogCurrent.replace(/\D/g, "")
      : null,
    declaredDutyCents:
      li.charges.length === 0
        ? null
        : li.charges
            .filter((c) => DUTY_CHARGE_TYPES.has(c.chargeType))
            .reduce((sum, c) => sum + Math.round(Number(c.amount) * 100), 0),
  };
}

// ------------------------------------------------------------------- queue

export type VarianceQueueRow = {
  alertId: string;
  alertKey: string;
  alertType: string;
  /** Any status — the page partitions open (active) from decided
   *  (archived); headline stats count open rows only. */
  status: "open" | "resolved" | "dismissed";
  severity: "error" | "warning" | "info";
  label: string;
  message: string;
  details: Record<string, unknown> | null;
  entryId: string;
  entryNumber: string;
  entryDate: string | null;
  entryStatus: string;
  lineItemId: string | null;
  lineNumber: number | null;
  sku: string | null;
  description: string | null;
  partId: string | null;
  /** Declared + committed-catalog codes for the HTS segment-diff cell;
   *  null outside classification variances' needs. */
  declaredHts: string | null;
  catalogHts: string | null;
  impactCents: number | null;
  direction: "recoverable" | "exposure" | null;
  window: LiquidationWindow;
  /** Line-scoped variances reconcile at /variance/[id]; entry-scoped ones
   *  land on the entry page. */
  href: string;
};

export async function getVarianceQueue(): Promise<VarianceQueueRow[]> {
  const orgId = await getCurrentOrgId();

  // Every status: decided rows feed the queue's archived view, and a line's
  // open/decided split decides which side of it the line lands on.
  const alerts = await db.query.auditAlerts.findMany({
    where: eq(schema.auditAlerts.orgId, orgId),
    with: {
      entry: {
        with: {
          // Liquidation evidence for the derived entry status + window.
          refundClaims: { columns: { liquidationDate: true } },
        },
      },
      lineItem: {
        with: {
          part: { with: { classifications: true } },
          charges: true,
        },
      },
    },
  });

  const entryIds = [...new Set(alerts.map((a) => a.entryId))];
  const [ref, shipmentLinks] = await Promise.all([
    getReferenceDataForOrg(),
    // inArray rejects empty arrays.
    entryIds.length === 0
      ? Promise.resolve([])
      : db.query.entryShipments.findMany({
          where: inArray(schema.entryShipments.entryId, entryIds),
          with: { shipment: true },
        }),
  ]);

  const sailByEntry = new Map<string, SailInfo>();
  for (const id of entryIds) {
    sailByEntry.set(
      id,
      resolveSailInfo(
        shipmentLinks.filter((l) => l.entryId === id).map((l) => l.shipment),
      ),
    );
  }

  // A trust-gate alert means the entry's charge data can't ground dollars.
  // Open gates only — a dismissed gate is a human saying the data is fine,
  // matching the detail page's entryTrusted check.
  const untrustedEntries = new Set(
    alerts
      .filter(
        (a) => a.status === "open" && a.alertType === "data_unreconciled",
      )
      .map((a) => a.entryId),
  );

  const today = todayIso();
  const rows: VarianceQueueRow[] = alerts.map((a) => {
    const details = detailsOf(a.details);
    const entryStatus = deriveEntryStatus(a.entry.refundClaims, today);
    const snapshot = snapshotOf(a.lineItem, a.entry.entryDate);
    const ctx: ImpactContext = {
      ref,
      entryDate: a.entry.entryDate,
      sail: sailByEntry.get(a.entryId) ?? null,
      entryTrusted: !untrustedEntries.has(a.entryId),
    };
    const impact = computeAlertImpact(
      { alertType: a.alertType, details },
      snapshot,
      ctx,
    );

    const part = a.lineItem?.part ?? null;
    // As-of code for discrepancies (the governing expectation); the current
    // window's code for reclassified rows (the interesting side of THAT diff).
    const catalogHtsAsOf = catalogCodeAsOf(part, a.entry.entryDate);
    const catalogHtsCurrent = catalogCodeAsOf(part, null);
    // Line re-ingested away: fall back to what the alert recorded.
    const isHts = a.alertType === "hts_discrepancy";
    const isReclassified = a.alertType === "hts_reclassified";
    const detailStr = (key: string) =>
      typeof details?.[key] === "string" ? (details[key] as string) : null;

    return {
      alertId: a.id,
      alertKey: a.alertKey,
      alertType: a.alertType,
      status: a.status,
      severity: a.severity,
      label: a.label,
      message: a.message,
      details,
      entryId: a.entryId,
      entryNumber: a.entry.entryNumber,
      entryDate: a.entry.entryDate,
      entryStatus,
      lineItemId: a.lineItemId,
      lineNumber:
        a.lineItem?.lineNumber ??
        (typeof details?.line_number === "number"
          ? (details.line_number as number)
          : null),
      sku: a.lineItem?.sku ?? detailStr("sku"),
      description: a.lineItem?.description ?? null,
      partId: a.lineItem?.partId ?? null,
      declaredHts:
        a.lineItem?.htsCode ??
        (isHts
          ? detailStr("actual_hts")
          : isReclassified
            ? detailStr("declared_hts")
            : null),
      catalogHts: isReclassified
        ? (catalogHtsCurrent ?? detailStr("expected_hts_current"))
        : (catalogHtsAsOf ?? (isHts ? detailStr("expected_hts") : null)),
      impactCents: impact.impactCents,
      direction: impact.direction,
      window: liquidationWindow(a.entry.entryDate, entryStatus, today),
      href: a.lineItemId ? `/variance/${a.id}` : `/entries/${a.entryId}`,
    };
  });

  // Novel AI findings ride the same queue. Impact stays null, so they sort
  // into the zero-impact tail unless they share a line with a rule row —
  // exactly where a human-triage queue wants uncosted claims.
  const findings = await db.query.analysisFindings.findMany({
    where: eq(schema.analysisFindings.orgId, orgId),
    with: {
      entry: {
        with: { refundClaims: { columns: { liquidationDate: true } } },
      },
      lineItem: true,
    },
  });
  for (const f of findings) {
    const related = Array.isArray(f.relatedAlertKeys)
      ? (f.relatedAlertKeys as string[])
      : [];
    if (related.length > 0) continue;
    const entryStatus = deriveEntryStatus(f.entry.refundClaims, today);
    rows.push({
      alertId: f.id,
      alertKey: f.findingKey,
      alertType: `ai_${f.category}`,
      status: f.status,
      severity: f.severity,
      label: f.title,
      message: f.title,
      details: {
        line_number: f.lineNumber,
        confidence: Number(f.confidence),
        explanation: f.explanation,
        suggested_action: f.suggestedAction,
        // The filed-vs-expected rows — fieldIssue() reads these, so the
        // queue cell, inline line findings, and CSV all render AI rows
        // through the same diff path as rule rows.
        fields: Array.isArray(f.fields) ? f.fields : [],
      },
      entryId: f.entryId,
      entryNumber: f.entry.entryNumber,
      entryDate: f.entry.entryDate,
      entryStatus,
      lineItemId: f.lineItemId,
      lineNumber: f.lineItem?.lineNumber ?? f.lineNumber,
      sku: f.lineItem?.sku ?? null,
      description: f.lineItem?.description ?? null,
      partId: f.lineItem?.partId ?? null,
      declaredHts: f.lineItem?.htsCode ?? null,
      catalogHts: null,
      impactCents: null,
      direction: null,
      window: liquidationWindow(f.entry.entryDate, entryStatus, today),
      href: f.lineItemId ? `/variance/${f.id}` : `/entries/${f.entryId}`,
    });
  }

  // Money first (nulls last), then severity, then a stable entry/line order.
  rows.sort((x, y) => {
    const ax = x.impactCents === null ? -1 : Math.abs(x.impactCents);
    const ay = y.impactCents === null ? -1 : Math.abs(y.impactCents);
    if (ax !== ay) return ay - ax;
    const s = SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity];
    if (s !== 0) return s;
    if (x.entryNumber !== y.entryNumber)
      return x.entryNumber < y.entryNumber ? -1 : 1;
    return (x.lineNumber ?? 0) - (y.lineNumber ?? 0);
  });

  return rows;
}

// ------------------------------------------------------------------ detail

export type VarianceCatalogExpected = {
  baseDuty: { rate: number | null; amountCents: number | null } | null;
  measures: {
    name: string;
    ch99Code: string;
    // Null = non-ad-valorem measure (presence-only; amount not computable).
    rate: number | null;
    amountCents: number | null;
  }[];
  /** Null when the catalog base duty is non-computable. */
  totalCents: number | null;
  declaredDutyCents: number | null;
};

export type VarianceInvoice = {
  id: string;
  invoiceNumber: string;
  supplierName: string | null;
  invoiceDate: string | null;
  currency: string;
  totalAmount: string | null;
  lines: {
    lineNumber: number;
    sku: string | null;
    htsCode: string | null;
    countryOfOrigin: string | null;
    quantity: string | null;
    unitPrice: string | null;
    totalPrice: string;
  }[];
};

export type VarianceSiblingAlert = {
  id: string;
  alertKey: string;
  alertType: string;
  severity: "error" | "warning" | "info";
  label: string;
  message: string;
  status: "open" | "resolved" | "dismissed";
  /** When the decision landed; null while open. Drives the inline Undo's
   *  target — the most recently decided unit on the line. */
  resolvedAt: Date | null;
  impactCents: number | null;
  direction: "recoverable" | "exposure" | null;
  /** The alert's comparison snapshot — lets the detail page render a whole
   *  UNIT's diff (e.g. the rate twin's row while viewing the amount half). */
  details: Record<string, unknown> | null;
};

export type VarianceDetail = {
  alert: {
    id: string;
    alertKey: string;
    alertType: string;
    severity: "error" | "warning" | "info";
    label: string;
    message: string;
    details: Record<string, unknown> | null;
    status: "open" | "resolved" | "dismissed";
    resolutionNote: string | null;
    lineItemId: string | null;
    partId: string | null;
  };
  entry: {
    id: string;
    entryNumber: string;
    entryDate: string | null;
    status: string;
    portOfEntry: string | null;
  };
  window: LiquidationWindow;
  /** The flagged 7501 line with its full read-side expectations; null when
   *  re-ingestion removed it (render from alert.details instead). */
  line: LineItemDetail | null;
  impact: AlertImpact;
  /** The duty stack under the catalog code — hts_discrepancy (as-of code)
   *  and hts_reclassified (current code) only. */
  catalogExpected: VarianceCatalogExpected | null;
  documents: EntryDocument[];
  /** The commercial invoice(s) the alert's details reference — the evidence
   *  behind CI-vs-entry findings. Empty for catalog/duty findings. */
  invoices: VarianceInvoice[];
  /** Every alert on the same line item (any status, current one included),
   *  in the queue's within-group order so "next" is predictable. Empty for
   *  entry-scoped alerts (which redirect to the entry page anyway). */
  siblings: VarianceSiblingAlert[];
};

export async function getVarianceDetail(
  alertId: string,
): Promise<VarianceDetail | null> {
  const orgId = await getCurrentOrgId();

  const alert = await db.query.auditAlerts.findFirst({
    where: and(
      eq(schema.auditAlerts.id, alertId),
      eq(schema.auditAlerts.orgId, orgId),
    ),
    with: {
      lineItem: {
        with: {
          part: { with: { classifications: true } },
          charges: true,
        },
      },
    },
  });
  if (!alert) return null;

  const ref = await getReferenceDataForOrg();
  const [detail, shipmentLinks] = await Promise.all([
    getEntryDetail(alert.entryId, ref),
    db.query.entryShipments.findMany({
      where: eq(schema.entryShipments.entryId, alert.entryId),
      with: { shipment: true },
    }),
  ]);
  if (!detail) return null;

  const line = alert.lineItemId
    ? (detail.lineItems.find((li) => li.id === alert.lineItemId) ?? null)
    : null;
  const details = detailsOf(alert.details);
  const snapshot = snapshotOf(alert.lineItem, detail.entryDate);
  const ctx: ImpactContext = {
    ref,
    entryDate: detail.entryDate,
    sail: resolveSailInfo(shipmentLinks.map((l) => l.shipment)),
    entryTrusted: !detail.alerts.some(
      (a) => a.status === "open" && a.alertType === "data_unreconciled",
    ),
  };
  const impact = computeAlertImpact(
    { alertType: alert.alertType, details },
    snapshot,
    ctx,
  );

  // The navigator card's data: every alert on the same line, any status.
  // Siblings share the line, so the snapshot/ctx above apply to all of
  // them; impact is status-independent, so accepted rows keep their dollar
  // figure. Decided issues band first, open ones last — a new issue landing
  // on an already-worked line shows below its decided history ("3 of 3") —
  // with the canonical order inside each band, so the open tail mirrors the
  // queue's grouped row. Raw impacts throughout — the navigator card folds
  // rate/amount twins into one unit (pairSiblingAlerts) and shows the
  // dollars once per unit, so no per-row blanking is needed here.
  const siblings: VarianceSiblingAlert[] = alert.lineItemId
    ? buildLineSiblings(detail, alert.lineItemId, snapshot, ctx)
    : [];

  // The duty stack under the catalog code: the as-of code for a
  // discrepancy, the current window's code for a reclassified line (what
  // the entry WOULD owe under today's classification). Computed for the
  // LINE's HTS issue — current alert or a sibling, any status — since the
  // diff table renders every issue's rows at once.
  let catalogExpected: VarianceCatalogExpected | null = null;
  const htsIssueType =
    [alert.alertType, ...siblings.map((s) => s.alertType)].find(
      (t) => t === "hts_discrepancy" || t === "hts_reclassified",
    ) ?? null;
  const wantsCatalogExpected =
    htsIssueType === "hts_discrepancy" ||
    (htsIssueType === "hts_reclassified" && snapshot?.catalogHtsDigitsCurrent);
  if (wantsCatalogExpected && snapshot) {
    const expected =
      htsIssueType === "hts_reclassified"
        ? computeCatalogExpected(
            snapshot,
            ctx,
            snapshot.catalogHtsDigitsCurrent!,
          )
        : computeCatalogExpected(snapshot, ctx);
    if (expected) {
      catalogExpected = {
        baseDuty: expected.baseDuty
          ? {
              rate: expected.baseDuty.rate,
              amountCents: expected.baseDuty.amountCents,
            }
          : null,
        measures: expected.measures.map((m) => ({
          name: m.name,
          ch99Code: m.ch99Code,
          rate: m.rate,
          amountCents: m.amountCents,
        })),
        totalCents: expectedTotalCents(expected),
        declaredDutyCents: snapshot.declaredDutyCents,
      };
    }
  }

  // CI-vs-entry alerts name their evidence invoices in details.
  const invoiceNumbers = [
    ...new Set([
      ...(Array.isArray(details?.invoice_numbers)
        ? (details.invoice_numbers as unknown[]).filter(
            (n): n is string => typeof n === "string",
          )
        : []),
      ...(typeof details?.invoice_number === "string"
        ? [details.invoice_number]
        : []),
    ]),
  ];
  const invoiceRows =
    invoiceNumbers.length === 0
      ? []
      : await db.query.invoices.findMany({
          where: and(
            eq(schema.invoices.orgId, orgId),
            inArray(schema.invoices.invoiceNumber, invoiceNumbers),
          ),
          with: {
            lineItems: { orderBy: (li, { asc }) => [asc(li.lineNumber)] },
          },
          orderBy: (inv, { asc }) => [asc(inv.invoiceNumber)],
        });
  const invoices: VarianceInvoice[] = invoiceRows.map((inv) => ({
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    supplierName: inv.supplierName,
    invoiceDate: inv.invoiceDate,
    currency: inv.currency,
    totalAmount: inv.totalAmount,
    lines: inv.lineItems.map((li) => ({
      lineNumber: li.lineNumber,
      sku: li.sku,
      htsCode: li.htsCode,
      countryOfOrigin: li.countryOfOrigin,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      totalPrice: li.totalPrice,
    })),
  }));

  return {
    alert: {
      id: alert.id,
      alertKey: alert.alertKey,
      alertType: alert.alertType,
      severity: alert.severity,
      label: alert.label,
      message: alert.message,
      details,
      status: alert.status,
      resolutionNote: alert.resolutionNote,
      lineItemId: alert.lineItemId,
      partId: alert.lineItem?.partId ?? null,
    },
    entry: {
      id: detail.id,
      entryNumber: detail.entryNumber,
      entryDate: detail.entryDate,
      status: detail.status,
      portOfEntry: detail.portOfEntry,
    },
    window: liquidationWindow(detail.entryDate, detail.status, todayIso()),
    line,
    impact,
    catalogExpected,
    documents: detail.documents,
    invoices,
    siblings,
  };
}

// -------------------------------------------------------------- AI detail

/** Every issue on one line — rule alerts AND novel AI findings — as
 *  navigator-card items in compareSiblingAlerts order, so both detail pages
 *  show one complete line reconciliation. Corroborating AI findings stay
 *  out: their issue is already a rule row. */
function buildLineSiblings(
  detail: EntryDetail,
  lineItemId: string,
  snapshot: ImpactLineSnapshot | null,
  ctx: ImpactContext,
): VarianceSiblingAlert[] {
  const alertItems: VarianceSiblingAlert[] = detail.alerts
    .filter((a) => a.lineItemId === lineItemId)
    .map((a) => {
      const impact = computeAlertImpact(
        { alertType: a.alertType, details: a.details },
        snapshot,
        ctx,
      );
      return {
        id: a.id,
        alertKey: a.alertKey,
        alertType: a.alertType,
        severity: a.severity,
        label: a.label,
        message: a.message,
        status: a.status,
        resolvedAt: a.resolvedAt,
        impactCents: impact.impactCents,
        direction: impact.direction,
        details: a.details,
      };
    });
  const findingItems: VarianceSiblingAlert[] = detail.aiFindings
    .filter(
      (f) => f.lineItemId === lineItemId && f.relatedAlertKeys.length === 0,
    )
    .map((f) => ({
      id: f.id,
      alertKey: f.findingKey,
      alertType: f.alertType,
      severity: f.severity,
      label: f.title,
      message: f.title,
      status: f.status,
      resolvedAt: f.resolvedAt,
      impactCents: null,
      direction: null,
      details: {
        confidence: f.confidence,
        explanation: f.explanation,
        suggested_action: f.suggestedAction,
        fields: f.fields,
      },
    }));
  return [...alertItems, ...findingItems].sort(compareSiblingAlerts);
}

export type AiVarianceDetail = {
  finding: AiFindingRow;
  analyzedAt: Date | null;
  model: string | null;
  entry: {
    id: string;
    entryNumber: string;
    entryDate: string | null;
    status: string;
    portOfEntry: string | null;
  };
  window: LiquidationWindow;
  /** The flagged 7501 line with its full read-side expectations; null for
   *  entry-level findings or re-ingested-away lines. */
  line: LineItemDetail | null;
  documents: EntryDocument[];
  siblings: VarianceSiblingAlert[];
};

/** Detail payload for /variance/[id] when the id is an analysis finding —
 *  the reconciliation page's AI variant. */
export async function getAiVarianceDetail(
  findingId: string,
): Promise<AiVarianceDetail | null> {
  const orgId = await getCurrentOrgId();

  const finding = await db.query.analysisFindings.findFirst({
    where: and(
      eq(schema.analysisFindings.id, findingId),
      eq(schema.analysisFindings.orgId, orgId),
    ),
    with: {
      lineItem: {
        with: {
          part: { with: { classifications: true } },
          charges: true,
        },
      },
      run: true,
    },
  });
  if (!finding) return null;

  const ref = await getReferenceDataForOrg();
  const [detail, shipmentLinks] = await Promise.all([
    getEntryDetail(finding.entryId, ref),
    db.query.entryShipments.findMany({
      where: eq(schema.entryShipments.entryId, finding.entryId),
      with: { shipment: true },
    }),
  ]);
  if (!detail) return null;
  const row = detail.aiFindings.find((f) => f.id === finding.id);
  if (!row) return null;

  const line = finding.lineItemId
    ? (detail.lineItems.find((li) => li.id === finding.lineItemId) ?? null)
    : null;
  const snapshot = snapshotOf(finding.lineItem, detail.entryDate);
  const ctx: ImpactContext = {
    ref,
    entryDate: detail.entryDate,
    sail: resolveSailInfo(shipmentLinks.map((l) => l.shipment)),
    entryTrusted: !detail.alerts.some(
      (a) => a.status === "open" && a.alertType === "data_unreconciled",
    ),
  };
  const siblings = finding.lineItemId
    ? buildLineSiblings(detail, finding.lineItemId, snapshot, ctx)
    : [];

  return {
    finding: row,
    analyzedAt: finding.run?.finishedAt ?? null,
    model: finding.run?.model ?? null,
    entry: {
      id: detail.id,
      entryNumber: detail.entryNumber,
      entryDate: detail.entryDate,
      status: detail.status,
      portOfEntry: detail.portOfEntry,
    },
    window: liquidationWindow(detail.entryDate, detail.status, todayIso()),
    line,
    documents: detail.documents,
    siblings,
  };
}
