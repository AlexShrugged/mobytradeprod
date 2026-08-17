import "server-only";

import { and, count, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import type { OpenAlertCounts } from "@/components/entries/audit-badge";
import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import {
  computeAuthorityBreakdown,
  effectiveDutyRate,
  type BucketTotal,
} from "@/lib/duty/authority";
import { computeExpectedCharges } from "@/lib/duty/calculator";
import { getReferenceDataForOrg } from "./reference";
import { resolveSailInfo } from "@/lib/duty/sail";
import type { ReferenceData, SailBasis } from "@/lib/duty/types";
import { resolveWindow } from "@/lib/effective-dating";
import { deriveEntryStatus } from "@/lib/entries/status";
import { deriveShipmentStatus } from "@/lib/shipments/status";
import {
  projectFutureEntries,
  type FutureEntry,
} from "@/lib/future-entries/project";
import { classifyShipment, type ImpactMeasure } from "@/lib/tariff-sync/impact";
import { computeActualLandedCost } from "@/lib/landed-cost/actual";
import { deriveRefundStage, type RefundStage } from "@/lib/refunds";

const EMPTY_ALERTS: OpenAlertCounts = { error: 0, warning: 0, info: 0 };

const centsOf = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

// duty + MPF + HMF; always derived, never stored.
function dutiesAndFees(
  totalDuty: string | null,
  mpfAmount: string | null,
  hmfAmount: string | null,
): string | null {
  const duty = centsOf(totalDuty);
  if (duty === null) return null;
  const total = duty + (centsOf(mpfAmount) ?? 0) + (centsOf(hmfAmount) ?? 0);
  return (total / 100).toFixed(2);
}

// ------------------------------------------------------------ shared helpers
//
// Sail-conditioned measure windows drive two things on the list: the
// "tariff change" badge on shipments whose entry has no date yet, and the
// future-entry deadline chip. Loaded once per request, mapped to the impact
// module's shape.

async function loadSailWindows(): Promise<ImpactMeasure[]> {
  const rows = await db.query.tradeMeasures.findMany({
    where: or(
      isNotNull(schema.tradeMeasures.sailedOnOrAfter),
      isNotNull(schema.tradeMeasures.sailedOnOrBefore),
    ),
  });
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    ch99Code: null,
    rate: null,
    scope: m.scope,
    effectiveDate: m.effectiveDate,
    endDate: m.endDate,
    sailedOnOrAfter: m.sailedOnOrAfter,
    sailedOnOrBefore: m.sailedOnOrBefore,
  }));
}

function tariffFlagFor(
  entryDate: string | null,
  shipment: {
    sailedOnBoardDate: string | null;
    etd: string | null;
    eta: string | null;
  },
  sailWindows: ImpactMeasure[],
  today: string,
): { measureName: string; deadline: string | null } | null {
  // A dated entry has settled the question; the badge is a heads-up for
  // goods whose entry date is still open.
  if (entryDate !== null) return null;
  for (const m of sailWindows) {
    const c = classifyShipment(shipment, m, today);
    if (c === "affected") return { measureName: m.name, deadline: null };
    if (typeof c === "object") {
      return { measureName: m.name, deadline: c.sparedIfEnteredBy };
    }
  }
  return null;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------- entries list

export type EntryShipmentRow = {
  id: string;
  shipmentNumber: string;
  billOfLading: string | null;
  containerNumber: string | null;
  carrier: string | null;
  vessel: string | null;
  mode: string;
  originPort: string | null;
  destinationPort: string | null;
  etd: string | null;
  eta: string | null;
  sailedOnBoardDate: string | null;
  status: string;
  poNumbers: string[];
  /** Set when the entry is not yet dated and a sail-conditioned measure
   *  window concerns this shipment: deadline = last safe entry date, null
   *  = already on the liable side. */
  tariffFlag: { measureName: string; deadline: string | null } | null;
};

export type EntryPurchaseOrderRow = {
  id: string;
  poNumber: string;
  supplierName: string | null;
  orderDate: string | null;
  currency: string;
  totalAmount: string | null;
};

export type EntryRow = {
  kind: "entry";
  id: string;
  entryNumber: string;
  entryDate: string | null;
  portOfEntry: string | null;
  entryType: string | null;
  status: string;
  totalEnteredValue: string | null;
  totalDuty: string | null;
  totalBaseDuty: string | null;
  mpfAmount: string | null;
  hmfAmount: string | null;
  dutiesAndFeesTotal: string | null;
  totalRefund: string | null;
  refundStage: RefundStage | null;
  lineItemCount: number;
  openAlerts: OpenAlertCounts;
  shipments: EntryShipmentRow[];
  purchaseOrders: EntryPurchaseOrderRow[];
};

export type EntriesPageResult = {
  rows: EntryRow[];
  totalCount: number;
  /** Effective page after clamping to the last page. */
  page: number;
};

export async function getEntries(opts: {
  page: number;
  per: number;
}): Promise<EntriesPageResult> {
  const orgId = await getCurrentOrgId();

  const totalCount = await db.$count(
    schema.entries,
    eq(schema.entries.orgId, orgId),
  );
  const page = Math.min(
    Math.max(1, opts.page),
    Math.max(1, Math.ceil(totalCount / opts.per)),
  );

  const rows = await db.query.entries.findMany({
    where: eq(schema.entries.orgId, orgId),
    orderBy: desc(schema.entries.entryDate),
    limit: opts.per,
    offset: (page - 1) * opts.per,
    with: {
      entryShipments: {
        with: {
          shipment: {
            with: {
              shipmentPurchaseOrders: { with: { purchaseOrder: true } },
            },
          },
        },
      },
      entryPurchaseOrders: { with: { purchaseOrder: true } },
    },
  });
  if (rows.length === 0) return { rows: [], totalCount, page };
  // Per-entry aggregates scoped to this page's entries only.
  const entryIds = rows.map((e) => e.id);

  const [lineCounts, alertCounts, findingCounts, linkedClaims, sailWindows] =
    await Promise.all([
      db
        .select({ entryId: schema.entryLineItems.entryId, value: count() })
        .from(schema.entryLineItems)
        .where(
          and(
            eq(schema.entryLineItems.orgId, orgId),
            inArray(schema.entryLineItems.entryId, entryIds),
          ),
        )
        .groupBy(schema.entryLineItems.entryId),
      db
        .select({
          entryId: schema.auditAlerts.entryId,
          severity: schema.auditAlerts.severity,
          value: count(),
        })
        .from(schema.auditAlerts)
        .where(
          and(
            eq(schema.auditAlerts.orgId, orgId),
            eq(schema.auditAlerts.status, "open"),
            inArray(schema.auditAlerts.entryId, entryIds),
          ),
        )
        .groupBy(schema.auditAlerts.entryId, schema.auditAlerts.severity),
      // Open NOVEL AI findings count as variances too — corroborations
      // would double-count the rule row they ride on.
      db
        .select({
          entryId: schema.analysisFindings.entryId,
          severity: schema.analysisFindings.severity,
          value: count(),
        })
        .from(schema.analysisFindings)
        .where(
          and(
            eq(schema.analysisFindings.orgId, orgId),
            eq(schema.analysisFindings.status, "open"),
            inArray(schema.analysisFindings.entryId, entryIds),
            sql`${schema.analysisFindings.relatedAlertKeys} = '[]'::jsonb`,
          ),
        )
        .groupBy(
          schema.analysisFindings.entryId,
          schema.analysisFindings.severity,
        ),
      db.query.refundClaims.findMany({
        where: and(
          eq(schema.refundClaims.orgId, orgId),
          inArray(schema.refundClaims.entryId, entryIds),
        ),
        columns: {
          entryId: true,
          claimStatus: true,
          refundStatus: true,
          refundClassAmount: true,
          refundInterestAmount: true,
          liquidationDate: true,
        },
      }),
      loadSailWindows(),
    ]);

  const today = todayIso();
  const lineCountByEntry = new Map(lineCounts.map((r) => [r.entryId, r.value]));
  const alertsByEntry = new Map<string, OpenAlertCounts>();
  for (const r of alertCounts) {
    const counts = alertsByEntry.get(r.entryId) ?? { ...EMPTY_ALERTS };
    counts[r.severity] = r.value;
    alertsByEntry.set(r.entryId, counts);
  }
  for (const r of findingCounts) {
    const counts = alertsByEntry.get(r.entryId) ?? { ...EMPTY_ALERTS };
    counts[r.severity] += r.value;
    alertsByEntry.set(r.entryId, counts);
  }
  // When an entry has several claims, surface the stage of the largest one.
  const stageByEntry = new Map<string, { stage: RefundStage; cents: number }>();
  const claimsByEntry = new Map<string, { liquidationDate: string | null }[]>();
  for (const c of linkedClaims) {
    if (!c.entryId) continue;
    const claims = claimsByEntry.get(c.entryId) ?? [];
    claims.push({ liquidationDate: c.liquidationDate });
    claimsByEntry.set(c.entryId, claims);
    const cents =
      Math.round(Number(c.refundClassAmount) * 100) +
      Math.round(Number(c.refundInterestAmount) * 100);
    const current = stageByEntry.get(c.entryId);
    if (!current || cents > current.cents) {
      stageByEntry.set(c.entryId, {
        stage: deriveRefundStage(c.claimStatus, c.refundStatus),
        cents,
      });
    }
  }

  const entryRows: EntryRow[] = rows.map((entry) => ({
    kind: "entry" as const,
    id: entry.id,
    entryNumber: entry.entryNumber,
    entryDate: entry.entryDate,
    portOfEntry: entry.portOfEntry,
    entryType: entry.entryType,
    status: deriveEntryStatus(claimsByEntry.get(entry.id) ?? [], today),
    totalEnteredValue: entry.totalEnteredValue,
    totalDuty: entry.totalDuty,
    totalBaseDuty: entry.totalBaseDuty,
    mpfAmount: entry.mpfAmount,
    hmfAmount: entry.hmfAmount,
    dutiesAndFeesTotal: dutiesAndFees(
      entry.totalDuty,
      entry.mpfAmount,
      entry.hmfAmount,
    ),
    totalRefund: entry.totalRefund,
    refundStage: stageByEntry.get(entry.id)?.stage ?? null,
    lineItemCount: lineCountByEntry.get(entry.id) ?? 0,
    openAlerts: alertsByEntry.get(entry.id) ?? EMPTY_ALERTS,
    shipments: entry.entryShipments.map(({ shipment }) => ({
      id: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      billOfLading: shipment.billOfLading,
      containerNumber: shipment.containerNumber,
      carrier: shipment.carrier,
      vessel: shipment.vessel,
      mode: shipment.mode,
      originPort: shipment.originPort,
      destinationPort: shipment.destinationPort,
      etd: shipment.etd,
      eta: shipment.eta,
      sailedOnBoardDate: shipment.sailedOnBoardDate,
      // Reached through an entry link, which is itself arrival evidence.
      status: deriveShipmentStatus(shipment, true, today),
      poNumbers: shipment.shipmentPurchaseOrders.map(
        (spo) => spo.purchaseOrder.poNumber,
      ),
      tariffFlag: tariffFlagFor(entry.entryDate, shipment, sailWindows, today),
    })),
    purchaseOrders: entry.entryPurchaseOrders.map(({ purchaseOrder }) => ({
      id: purchaseOrder.id,
      poNumber: purchaseOrder.poNumber,
      supplierName: purchaseOrder.supplierName,
      orderDate: purchaseOrder.orderDate,
      currency: purchaseOrder.currency,
      totalAmount: purchaseOrder.totalAmount,
    })),
  }));

  return { rows: entryRows, totalCount, page };
}

// ----------------------------------------------------------- future entries
//
// The derived projection above the real rows: in-transit/booked shipments
// with no entry yet, with estimated money (src/lib/future-entries/project.ts
// is the pure half). Shaped to share the table's expansion UI with EntryRow.

export type FutureEntryRow = {
  kind: "future";
  id: string; // "future:" + shipmentId
  shipmentNumber: string;
  projectedEntryDate: string | null; // the shipment's ETA
  portOfEntry: string | null; // destination port — the projected port
  estimatedLineCount: number;
  estimatedEnteredValueCents: number | null;
  estimatedBaseDutyCents: number | null;
  estimatedAdditionalDutiesCents: number | null;
  estimatedMpfCents: number | null;
  estimatedHmfCents: number | null;
  estimatedDutiesCents: number | null;
  sailBasis: SailBasis;
  /** Savings-clause deadline — the amber chip on the projected row. */
  deadline: { measureName: string; enteredBy: string } | null;
  shipments: EntryShipmentRow[];
  purchaseOrders: EntryPurchaseOrderRow[];
};

export async function getFutureEntries(): Promise<FutureEntryRow[]> {
  const orgId = await getCurrentOrgId();

  const [shipments, enteredRows, sailWindows, ref] = await Promise.all([
    db.query.shipments.findMany({
      where: eq(schema.shipments.orgId, orgId),
      with: {
        shipmentPurchaseOrders: {
          with: {
            purchaseOrder: {
              with: {
                lines: {
                  with: {
                    part: {
                      with: {
                        // Projections are forward-looking: current windows only.
                        sources: { where: (s, { isNull }) => isNull(s.validTo) },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    db
      .select({ shipmentId: schema.entryShipments.shipmentId })
      .from(schema.entryShipments)
      .where(eq(schema.entryShipments.orgId, orgId)),
    loadSailWindows(),
    getReferenceDataForOrg(),
  ]);

  const today = todayIso();
  const projected = projectFutureEntries({
    shipments: shipments.map((s) => ({
      id: s.id,
      shipmentNumber: s.shipmentNumber,
      billOfLading: s.billOfLading,
      containerNumber: s.containerNumber,
      carrier: s.carrier,
      vessel: s.vessel,
      mode: s.mode,
      originPort: s.originPort,
      destinationPort: s.destinationPort,
      etd: s.etd,
      eta: s.eta,
      sailedOnBoardDate: s.sailedOnBoardDate,
      purchaseOrders: s.shipmentPurchaseOrders.map(({ purchaseOrder }) => ({
        id: purchaseOrder.id,
        poNumber: purchaseOrder.poNumber,
        supplierName: purchaseOrder.supplierName,
        vendorId: purchaseOrder.vendorId,
        orderDate: purchaseOrder.orderDate,
        currency: purchaseOrder.currency,
        totalAmount: purchaseOrder.totalAmount,
        lines: purchaseOrder.lines.map((l) => ({
          sku: l.sku,
          description: l.description,
          countryOfOrigin: l.countryOfOrigin,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          totalPrice: l.totalPrice,
          part: l.part
            ? {
                status: l.part.status,
                htsCode: l.part.htsCode,
                htsCodeProvisional: l.part.htsCodeProvisional,
                sources: l.part.sources.map((src) => ({
                  vendorId: src.vendorId,
                  countryOfOrigin: src.countryOfOrigin,
                })),
              }
            : null,
        })),
      })),
    })),
    enteredShipmentIds: new Set(enteredRows.map((r) => r.shipmentId)),
    sailMeasures: sailWindows,
    ref,
    today,
  });

  return projected.map((f: FutureEntry) => ({
    kind: "future" as const,
    id: f.id,
    shipmentNumber: f.shipment.shipmentNumber,
    projectedEntryDate: f.projectedEntryDate,
    portOfEntry: f.shipment.destinationPort,
    estimatedLineCount: f.estimatedLines.length,
    estimatedEnteredValueCents: f.estimatedEnteredValueCents,
    estimatedBaseDutyCents: f.estimatedBaseDutyCents,
    estimatedAdditionalDutiesCents: f.estimatedAdditionalDutiesCents,
    estimatedMpfCents: f.estimatedMpfCents,
    estimatedHmfCents: f.estimatedHmfCents,
    estimatedDutiesCents: f.estimatedDutiesCents,
    sailBasis: f.sailBasis,
    deadline: f.deadline,
    shipments: [
      {
        id: f.shipment.id,
        shipmentNumber: f.shipment.shipmentNumber,
        billOfLading: f.shipment.billOfLading,
        containerNumber: f.shipment.containerNumber,
        carrier: f.shipment.carrier,
        vessel: f.shipment.vessel,
        mode: f.shipment.mode,
        originPort: f.shipment.originPort,
        destinationPort: f.shipment.destinationPort,
        etd: f.shipment.etd,
        eta: f.shipment.eta,
        sailedOnBoardDate: f.shipment.sailedOnBoardDate,
        // Projected = not entered; the derived state is booked/in_transit.
        status: deriveShipmentStatus(f.shipment, false, today),
        poNumbers: f.purchaseOrders.map((po) => po.poNumber),
        // No entry, so no entry date — the flag always evaluates.
        tariffFlag: tariffFlagFor(null, f.shipment, sailWindows, today),
      },
    ],
    purchaseOrders: f.purchaseOrders.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      supplierName: po.supplierName,
      orderDate: po.orderDate,
      currency: po.currency,
      totalAmount: po.totalAmount,
    })),
  }));
}

// ------------------------------------------------------------ summary stats

export type EntrySummaryStats = {
  entryCount: number;
  /** Entries dated in the current calendar year with duty data. */
  ytdEntryCount: number;
  dutiesAndFeesYtdCents: number;
  refundClaimCount: number;
  refundTotalCents: number;
  refundPaidCents: number;
  refundPendingCents: number;
  openAlertCount: number;
  /** Sum of future entries' estimated duties; null when nothing computable. */
  inTransitExposureCents: number | null;
  futureEntryCount: number;
};

/**
 * KPI rollups for the Entries page. Pass the future entries when the caller
 * already loaded them (the page does) so the projection runs once.
 */
export async function getEntrySummaryStats(
  future?: FutureEntryRow[],
): Promise<EntrySummaryStats> {
  const orgId = await getCurrentOrgId();

  const [entryRows, claims, openAlerts, futureRows] = await Promise.all([
    db.query.entries.findMany({
      where: eq(schema.entries.orgId, orgId),
      columns: {
        entryDate: true,
        totalDuty: true,
        mpfAmount: true,
        hmfAmount: true,
      },
    }),
    db.query.refundClaims.findMany({
      where: eq(schema.refundClaims.orgId, orgId),
      columns: {
        claimStatus: true,
        refundStatus: true,
        refundClassAmount: true,
        refundInterestAmount: true,
      },
    }),
    db
      .select({ value: count() })
      .from(schema.auditAlerts)
      .where(
        and(
          eq(schema.auditAlerts.orgId, orgId),
          eq(schema.auditAlerts.status, "open"),
        ),
      ),
    future ? Promise.resolve(future) : getFutureEntries(),
  ]);

  const year = todayIso().slice(0, 4);
  let ytdEntryCount = 0;
  let dutiesAndFeesYtdCents = 0;
  for (const e of entryRows) {
    if (!e.entryDate?.startsWith(year)) continue;
    const duty = centsOf(e.totalDuty);
    if (duty === null) continue;
    ytdEntryCount += 1;
    dutiesAndFeesYtdCents +=
      duty + (centsOf(e.mpfAmount) ?? 0) + (centsOf(e.hmfAmount) ?? 0);
  }

  // Rejected claims never reach the money; the rest split paid vs pending
  // by the derived stage (pending covers pending_payout and processing).
  let refundTotalCents = 0;
  let refundPaidCents = 0;
  let refundPendingCents = 0;
  for (const c of claims) {
    const stage = deriveRefundStage(c.claimStatus, c.refundStatus);
    if (stage === "rejected") continue;
    const cents =
      Math.round(Number(c.refundClassAmount) * 100) +
      Math.round(Number(c.refundInterestAmount) * 100);
    refundTotalCents += cents;
    if (stage === "paid") refundPaidCents += cents;
    else refundPendingCents += cents;
  }

  const exposed = futureRows.filter((f) => f.estimatedDutiesCents !== null);
  return {
    entryCount: entryRows.length,
    ytdEntryCount,
    dutiesAndFeesYtdCents,
    refundClaimCount: claims.length,
    refundTotalCents,
    refundPaidCents,
    refundPendingCents,
    openAlertCount: openAlerts[0]?.value ?? 0,
    inTransitExposureCents:
      exposed.length === 0
        ? null
        : exposed.reduce((sum, f) => sum + (f.estimatedDutiesCents ?? 0), 0),
    futureEntryCount: futureRows.length,
  };
}

// ------------------------------------------------------------ entry detail

export type LineChargeDetail = {
  id: string;
  chargeType: string;
  htsCode: string | null;
  rate: string | null;
  amount: string;
  /** Official expectation from the duty calculator; null when we cannot
   *  compute one (unknown code, MPF/HMF, suppressed measure). */
  expectedRate: number | null;
  expectedAmount: number | null; // dollars
  measureName: string | null;
  /** Set when this charge matches a measure a stacking rule suppressed. */
  suppressedReason: string | null;
  rateMismatch: boolean;
  amountMismatch: boolean;
};

export type MissingMeasureDetail = {
  name: string;
  ch99Code: string;
  // Null = non-ad-valorem measure (presence-only; amount not computable).
  rate: number | null;
  expectedAmount: number | null; // dollars
};

export type LineItemDetail = {
  id: string;
  lineNumber: number;
  sku: string | null;
  description: string | null;
  htsCode: string;
  countryOfOrigin: string | null;
  /** Per-line supplier as declared on the 7501 — entries can span vendors. */
  supplierName: string | null;
  quantity: string | null;
  unitValue: string | null;
  enteredValue: string;
  partId: string | null;
  /** The committed catalog code AS OF the entry date; null when absent or
   *  merely provisional. */
  catalogHtsCode: string | null;
  /** The committed catalog code under the CURRENT classification window —
   *  differs from catalogHtsCode when the part was reclassified after this
   *  entry was filed. */
  catalogHtsCodeCurrent: string | null;
  /** A classifier-auto-selected code awaiting review — display-only. */
  catalogProvisionalCode: string | null;
  htsMismatch: boolean;
  dutiesAndFees: string;
  /** Entered value + all declared charges (duty-inclusive landed cost). */
  landedValue: string;
  landedPerUnit: string | null;
  openAlerts: OpenAlertCounts;
  charges: LineChargeDetail[];
  missingMeasures: MissingMeasureDetail[];
};

export type AlertRow = {
  id: string;
  alertKey: string;
  alertType: string;
  severity: "error" | "warning" | "info";
  label: string;
  message: string;
  details: Record<string, unknown> | null;
  status: "open" | "resolved" | "dismissed";
  /** When the decision landed; null while open (cleared on reopen). */
  resolvedAt: Date | null;
  lineItemId: string | null;
  lineNumber: number | null;
  /** The catalog part behind the flagged line — the jump into HTS review. */
  partId: string | null;
  resolutionNote: string | null;
};

export type AiFindingRow = {
  id: string;
  findingKey: string;
  category: string;
  /** "ai_" + category — the StatusBadge vocabulary shared with the queue. */
  alertType: string;
  severity: "error" | "warning" | "info";
  title: string;
  explanation: string;
  suggestedAction: string;
  confidence: number;
  status: "open" | "resolved" | "dismissed";
  resolvedAt: Date | null;
  resolutionNote: string | null;
  lineItemId: string | null;
  lineNumber: number | null;
  partId: string | null;
  /** Deterministic alertKeys this finding corroborates; [] = novel. */
  relatedAlertKeys: string[];
  /** Filed-vs-expected rows for the reconciliation field table. */
  fields: { field: string; filed: string | null; expected: string | null }[];
  evidence: {
    source: string;
    documentId: string | null;
    field: string | null;
    quote: string;
    /** Human sentence; absent on findings persisted before it existed. */
    statement?: string;
  }[];
};

export type EntryAnalysisState = {
  /** Most recent terminal run; null when the analyst has never finished. */
  latestRun: {
    id: string;
    status: "succeeded" | "failed";
    analyst: string | null;
    model: string | null;
    summary: string | null;
    error: string | null;
    finishedAt: Date | null;
  } | null;
  /** A run is executing right now. */
  running: boolean;
  /** A tariff apply queued a re-analysis that has not started yet. A
   *  manual Analyze claims the queued row, so the action stays available. */
  queued: boolean;
};

export type RefundClaimDetail = {
  id: string;
  claimType: string;
  claimStatus: string | null;
  refundStatus: string | null;
  refundNumber: string | null;
  stage: RefundStage;
  classAmount: string;
  interestAmount: string;
  totalAmount: string;
  liquidationDate: string | null;
  refundDate: string | null;
};

export type EntryDocument = {
  id: string;
  fileName: string;
  docType: string;
  fileSize: number;
  /** true = this document created the entry; false = it references it. */
  created: boolean;
};

export type EntryDetail = {
  id: string;
  entryNumber: string;
  entryDate: string | null;
  portOfEntry: string | null;
  entryType: string | null;
  importerOfRecord: string | null;
  status: string;
  totalEnteredValue: string | null;
  totalDuty: string | null;
  totalBaseDuty: string | null;
  additionalDuties: string | null;
  mpfAmount: string | null;
  hmfAmount: string | null;
  dutiesAndFeesTotal: string | null;
  totalRefund: string | null;
  /** Declared charges bucketed by authority (legacy measure semantics). */
  authorityBreakdown: BucketTotal[];
  /** Total duty / entered value, null when either is unknown. */
  effectiveDutyRate: number | null;
  /** Worst sail grounding across lines whose expectations hit a sail
   *  condition; null when none did. */
  sailBasis: SailBasis;
  lineItems: LineItemDetail[];
  alerts: AlertRow[];
  /** Persisted AI analyst findings, open-first. Corroborations included —
   *  the entry page shows the full report; the variance queue takes only
   *  the novel ones. */
  aiFindings: AiFindingRow[];
  analysis: EntryAnalysisState;
  refundClaims: RefundClaimDetail[];
  shipments: {
    id: string;
    shipmentNumber: string;
    status: string;
    /** Paperwork homed under this record (created it, or references it and
     *  was created nowhere else). */
    documents: EntryDocument[];
  }[];
  purchaseOrders: {
    id: string;
    poNumber: string;
    supplierName: string | null;
    currency: string;
    totalAmount: string | null;
    documents: EntryDocument[];
  }[];
  /** Commercial invoices directly linked via entry_invoices — the document
   *  truth the variance rules compare against. entryCount > 1 marks an
   *  invoice spanning entries (line comparison skipped). */
  invoices: {
    id: string;
    invoiceNumber: string;
    supplierName: string | null;
    currency: string;
    totalAmount: string | null;
    invoiceDate: string | null;
    entryCount: number;
    documents: EntryDocument[];
  }[];
  /** Every document linked to the ENTRY itself (the flat provenance list —
   *  what the variance detail page renders). */
  documents: EntryDocument[];
  /** Entry-homed paperwork: documents that belong to the entry rather than
   *  to one of its shipments/POs/invoices (the 7501, refund reports…). */
  entryPaperwork: EntryDocument[];
};

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
const BASIS_RANK = { exact: 0, estimated: 1, assumed: 2 } as const;

export async function getEntryDetail(
  entryId: string,
  preloadedRef?: ReferenceData,
): Promise<EntryDetail | null> {
  const orgId = await getCurrentOrgId();

  const entry = await db.query.entries.findFirst({
    where: eq(schema.entries.id, entryId),
    with: {
      lineItems: {
        with: { part: { with: { classifications: true } }, charges: true },
        orderBy: (li, { asc }) => [asc(li.lineNumber)],
      },
      auditAlerts: true,
      analysisFindings: true,
      analysisRuns: {
        orderBy: (r, { desc }) => [desc(r.createdAt)],
        limit: 10,
      },
      refundClaims: true,
      entryShipments: { with: { shipment: true } },
      entryPurchaseOrders: { with: { purchaseOrder: true } },
      entryInvoices: { with: { invoice: true } },
    },
  });
  if (!entry || entry.orgId !== orgId) return null;

  // How many entries each linked invoice spans — the applicability signal
  // the variance rules gate on, surfaced as context ("spans N entries").
  const linkedInvoiceIds = entry.entryInvoices.map((ei) => ei.invoiceId);
  const invoiceLinkRows = linkedInvoiceIds.length
    ? await db.query.entryInvoices.findMany({
        where: inArray(schema.entryInvoices.invoiceId, linkedInvoiceIds),
        columns: { invoiceId: true },
      })
    : [];
  const invoiceEntryCount = new Map<string, number>();
  for (const row of invoiceLinkRows) {
    invoiceEntryCount.set(
      row.invoiceId,
      (invoiceEntryCount.get(row.invoiceId) ?? 0) + 1,
    );
  }

  const linkedShipmentIds = entry.entryShipments.map((es) => es.shipmentId);
  const linkedPoIds = entry.entryPurchaseOrders.map(
    (epo) => epo.purchaseOrderId,
  );

  const [ref, documentRows] = await Promise.all([
    preloadedRef ?? getReferenceDataForOrg(),
    // Source documents via provenance links — for the entry itself AND its
    // linked shipments/POs/invoices, so paperwork renders under the record
    // it belongs to. raw_extraction never leaves the server (it can be
    // multiple MB per row).
    db
      .select({
        id: schema.documents.id,
        fileName: schema.documents.fileName,
        docType: schema.documents.docType,
        fileSize: schema.documents.fileSize,
        created: schema.documentLinks.created,
        entityType: schema.documentLinks.entityType,
        entityId: schema.documentLinks.entityId,
      })
      .from(schema.documentLinks)
      .innerJoin(
        schema.documents,
        eq(schema.documentLinks.documentId, schema.documents.id),
      )
      .where(
        and(
          eq(schema.documentLinks.orgId, orgId),
          or(
            and(
              eq(schema.documentLinks.entityType, "entry"),
              eq(schema.documentLinks.entityId, entryId),
            ),
            linkedShipmentIds.length
              ? and(
                  eq(schema.documentLinks.entityType, "shipment"),
                  inArray(schema.documentLinks.entityId, linkedShipmentIds),
                )
              : undefined,
            linkedPoIds.length
              ? and(
                  eq(schema.documentLinks.entityType, "purchase_order"),
                  inArray(schema.documentLinks.entityId, linkedPoIds),
                )
              : undefined,
            linkedInvoiceIds.length
              ? and(
                  eq(schema.documentLinks.entityType, "invoice"),
                  inArray(schema.documentLinks.entityId, linkedInvoiceIds),
                )
              : undefined,
          ),
        ),
      )
      .orderBy(desc(schema.documents.uploadedAt)),
  ]);

  // Home each document under exactly ONE group so it never renders twice:
  // an entry-created link wins (the 7501 also mints stub sub-records, but
  // it IS the entry's paperwork), then the sub-record it created (a BOL's
  // home is its shipment, a CI's its invoice), then the first sub-record it
  // merely references (a packing list under its shipment), else the entry.
  const linksByDoc = new Map<string, typeof documentRows>();
  for (const row of documentRows) {
    const list = linksByDoc.get(row.id) ?? [];
    list.push(row);
    linksByDoc.set(row.id, list);
  }
  const docsByHome = new Map<string, EntryDocument[]>();
  for (const links of linksByDoc.values()) {
    const home =
      links.find((l) => l.entityType === "entry" && l.created) ??
      links.find((l) => l.entityType !== "entry" && l.created) ??
      links.find((l) => l.entityType !== "entry") ??
      links[0];
    const key = `${home.entityType}:${home.entityId}`;
    const list = docsByHome.get(key) ?? [];
    list.push({
      id: home.id,
      fileName: home.fileName,
      docType: home.docType,
      fileSize: home.fileSize,
      created: home.created,
    });
    docsByHome.set(key, list);
  }
  const homeDocs = (entityType: string, entityId: string) =>
    docsByHome.get(`${entityType}:${entityId}`) ?? [];

  const openKeys = new Set(
    entry.auditAlerts
      .filter((a) => a.status === "open")
      .map((a) => a.alertKey),
  );
  const sail = resolveSailInfo(
    entry.entryShipments.map((es) => es.shipment),
  );

  let sailBasis: SailBasis = null;
  const lineItems: LineItemDetail[] = entry.lineItems.map((li) => {
    const enteredCents = Math.round(Number(li.enteredValue) * 100);
    const expected =
      entry.entryDate && li.countryOfOrigin
        ? computeExpectedCharges(
            {
              htsDigits: li.htsCodeDigits,
              countryOfOrigin: li.countryOfOrigin,
              enteredValueCents: enteredCents,
              entryDate: entry.entryDate,
              sail,
            },
            ref,
          )
        : null;
    if (
      expected?.sailBasis &&
      (sailBasis === null ||
        BASIS_RANK[expected.sailBasis] > BASIS_RANK[sailBasis])
    ) {
      sailBasis = expected.sailBasis;
    }

    const declaredDigits = new Set(
      li.charges.map((c) => c.htsCodeDigits).filter(Boolean),
    );

    let chargeCents = 0;
    const charges: LineChargeDetail[] = li.charges.map((c) => {
      chargeCents += Math.round(Number(c.amount) * 100);

      let expectedRate: number | null = null;
      let expectedAmount: number | null = null;
      let measureName: string | null = null;
      let suppressedReason: string | null = null;
      let refKey: string | null = null;

      if (c.chargeType === "base_duty") {
        refKey = "base";
        if (expected?.baseDuty && expected.baseDuty.rate !== null) {
          expectedRate = expected.baseDuty.rate;
          expectedAmount =
            expected.baseDuty.amountCents === null
              ? null
              : expected.baseDuty.amountCents / 100;
        }
      } else if (c.htsCodeDigits) {
        refKey = c.htsCodeDigits;
        const em = expected?.measures.find(
          (m) => m.ch99Digits === c.htsCodeDigits,
        );
        const sm = expected?.suppressed.find(
          (m) => m.ch99Digits === c.htsCodeDigits,
        );
        if (em) {
          expectedRate = em.rate;
          expectedAmount = em.amountCents === null ? null : em.amountCents / 100;
          measureName = em.name;
        } else if (sm) {
          measureName = sm.name;
          suppressedReason = sm.suppressedBy.reason;
        } else {
          const refRow = ref.htsByDigits.get(c.htsCodeDigits);
          const refMeasure = refRow?.tradeMeasureId
            ? ref.measures.find((m) => m.id === refRow.tradeMeasureId)
            : undefined;
          measureName = refMeasure?.name ?? null;
        }
      }

      return {
        id: c.id,
        chargeType: c.chargeType,
        htsCode: c.htsCode,
        rate: c.rate,
        amount: c.amount,
        expectedRate,
        expectedAmount,
        measureName,
        suppressedReason,
        rateMismatch: refKey
          ? openKeys.has(`rate_mismatch:line${li.lineNumber}:${refKey}`)
          : false,
        amountMismatch: refKey
          ? openKeys.has(`amount_mismatch:line${li.lineNumber}:${refKey}`)
          : false,
      };
    });

    const missingMeasures: MissingMeasureDetail[] = expected
      ? expected.measures
          .filter(
            (m) =>
              !declaredDigits.has(m.ch99Digits) &&
              !m.exclusionDigits.some((d) => declaredDigits.has(d)),
          )
          .map((m) => ({
            name: m.name,
            ch99Code: m.ch99Code,
            rate: m.rate,
            expectedAmount: m.amountCents === null ? null : m.amountCents / 100,
          }))
      : [];

    // Committed classification windows resolved AS OF the entry date — the
    // expectation that governed the filing — plus today's window for the
    // "reclassified since filing" hint. Provisional codes never create
    // windows, so the auditor's provisional guard is implicit here.
    const catalogHtsCode = li.part
      ? (resolveWindow(li.part.classifications, entry.entryDate)?.htsCode ??
        null)
      : null;
    const catalogHtsCodeCurrent = li.part
      ? (li.part.classifications.find((c) => c.validTo === null)?.htsCode ??
        null)
      : null;
    const catalogProvisionalCode =
      li.part && li.part.htsCodeProvisional ? li.part.htsCode : null;
    const lineAlerts = entry.auditAlerts.filter(
      (a) => a.status === "open" && a.lineItemId === li.id,
    );
    const openAlerts: OpenAlertCounts = { ...EMPTY_ALERTS };
    for (const a of lineAlerts) openAlerts[a.severity] += 1;
    // Open NOVEL AI findings count as line variances too (corroborations
    // would double-count the rule row they ride on) — same rule as the
    // variance queue.
    for (const f of entry.analysisFindings) {
      const related = Array.isArray(f.relatedAlertKeys)
        ? (f.relatedAlertKeys as string[])
        : [];
      if (f.status === "open" && f.lineItemId === li.id && related.length === 0)
        openAlerts[f.severity] += 1;
    }

    const landed = computeActualLandedCost(
      {
        enteredValueCents: enteredCents,
        quantity: li.quantity === null ? null : Number(li.quantity),
      },
      li.charges.map((c) => ({
        chargeType: c.chargeType,
        amountCents: Math.round(Number(c.amount) * 100),
        htsCode: c.htsCode,
        rate: c.rate === null ? null : Number(c.rate),
      })),
    );

    return {
      id: li.id,
      lineNumber: li.lineNumber,
      sku: li.sku,
      description: li.description,
      htsCode: li.htsCode,
      countryOfOrigin: li.countryOfOrigin,
      supplierName: li.supplierName,
      quantity: li.quantity,
      unitValue: li.unitValue,
      enteredValue: li.enteredValue,
      partId: li.partId,
      catalogHtsCode,
      catalogHtsCodeCurrent,
      catalogProvisionalCode,
      htsMismatch:
        catalogHtsCode !== null &&
        catalogHtsCode.replace(/\D/g, "") !== li.htsCodeDigits,
      dutiesAndFees: (chargeCents / 100).toFixed(2),
      landedValue: (landed.totalCents / 100).toFixed(2),
      landedPerUnit:
        landed.perUnitCents === null
          ? null
          : (landed.perUnitCents / 100).toFixed(2),
      openAlerts,
      charges,
      missingMeasures,
    };
  });

  const lineNumberById = new Map(
    entry.lineItems.map((li) => [li.id, li.lineNumber]),
  );
  const partIdByLineId = new Map(
    entry.lineItems.map((li) => [li.id, li.partId]),
  );
  const alerts: AlertRow[] = entry.auditAlerts
    .map((a) => ({
      id: a.id,
      alertKey: a.alertKey,
      alertType: a.alertType,
      severity: a.severity,
      label: a.label,
      message: a.message,
      details: (a.details as Record<string, unknown> | null) ?? null,
      status: a.status,
      resolvedAt: a.resolvedAt,
      lineItemId: a.lineItemId,
      lineNumber: a.lineItemId
        ? (lineNumberById.get(a.lineItemId) ?? null)
        : typeof (a.details as Record<string, unknown> | null)?.line_number ===
            "number"
          ? ((a.details as Record<string, unknown>).line_number as number)
          : null,
      partId: a.lineItemId ? (partIdByLineId.get(a.lineItemId) ?? null) : null,
      resolutionNote: a.resolutionNote,
    }))
    .sort(
      (a, b) =>
        (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.alertKey.localeCompare(b.alertKey),
    );

  const aiFindings: AiFindingRow[] = entry.analysisFindings
    .map((f) => ({
      id: f.id,
      findingKey: f.findingKey,
      category: f.category,
      alertType: `ai_${f.category}`,
      severity: f.severity,
      title: f.title,
      explanation: f.explanation,
      suggestedAction: f.suggestedAction,
      confidence: Number(f.confidence),
      status: f.status,
      resolvedAt: f.resolvedAt,
      resolutionNote: f.resolutionNote,
      lineItemId: f.lineItemId,
      lineNumber: f.lineItemId
        ? (lineNumberById.get(f.lineItemId) ?? f.lineNumber)
        : f.lineNumber,
      partId: f.lineItemId ? (partIdByLineId.get(f.lineItemId) ?? null) : null,
      relatedAlertKeys: Array.isArray(f.relatedAlertKeys)
        ? (f.relatedAlertKeys as string[])
        : [],
      fields: Array.isArray(f.fields)
        ? (f.fields as AiFindingRow["fields"])
        : [],
      evidence: Array.isArray(f.evidence)
        ? (f.evidence as AiFindingRow["evidence"])
        : [],
    }))
    .sort(
      (a, b) =>
        (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.findingKey.localeCompare(b.findingKey),
    );

  // Latest terminal run headlines the AI card; any pending/running row
  // means new results are on the way (manual run or tariff-apply queue).
  const terminalRun = entry.analysisRuns.find(
    (r) => r.status === "succeeded" || r.status === "failed",
  );
  const analysis: EntryAnalysisState = {
    latestRun: terminalRun
      ? {
          id: terminalRun.id,
          status: terminalRun.status as "succeeded" | "failed",
          analyst: terminalRun.analyst,
          model: terminalRun.model,
          summary: terminalRun.summary,
          error: terminalRun.error,
          finishedAt: terminalRun.finishedAt,
        }
      : null,
    running: entry.analysisRuns.some((r) => r.status === "running"),
    queued: entry.analysisRuns.some((r) => r.status === "pending"),
  };

  const refundClaims: RefundClaimDetail[] = entry.refundClaims.map((c) => {
    const totalCents =
      Math.round(Number(c.refundClassAmount) * 100) +
      Math.round(Number(c.refundInterestAmount) * 100);
    return {
      id: c.id,
      claimType: c.claimType,
      claimStatus: c.claimStatus,
      refundStatus: c.refundStatus,
      refundNumber: c.refundNumber,
      stage: deriveRefundStage(c.claimStatus, c.refundStatus),
      classAmount: c.refundClassAmount,
      interestAmount: c.refundInterestAmount,
      totalAmount: (totalCents / 100).toFixed(2),
      liquidationDate: c.liquidationDate,
      refundDate: c.refundDate,
    };
  });

  const baseCents = centsOf(entry.totalBaseDuty);
  const dutyCents = centsOf(entry.totalDuty);

  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    entryDate: entry.entryDate,
    portOfEntry: entry.portOfEntry,
    entryType: entry.entryType,
    importerOfRecord: entry.importerOfRecord,
    status: deriveEntryStatus(entry.refundClaims, todayIso()),
    totalEnteredValue: entry.totalEnteredValue,
    totalDuty: entry.totalDuty,
    totalBaseDuty: entry.totalBaseDuty,
    additionalDuties:
      dutyCents !== null && baseCents !== null
        ? ((dutyCents - baseCents) / 100).toFixed(2)
        : null,
    mpfAmount: entry.mpfAmount,
    hmfAmount: entry.hmfAmount,
    dutiesAndFeesTotal: dutiesAndFees(
      entry.totalDuty,
      entry.mpfAmount,
      entry.hmfAmount,
    ),
    totalRefund: entry.totalRefund,
    authorityBreakdown: computeAuthorityBreakdown(
      entry.lineItems.flatMap((li) =>
        li.charges.map((c) => ({
          chargeType: c.chargeType,
          htsCodeDigits: c.htsCodeDigits,
          rate: c.rate,
          amount: c.amount,
        })),
      ),
      ref,
      entry.entryDate,
    ),
    effectiveDutyRate: effectiveDutyRate(
      dutyCents,
      centsOf(entry.totalEnteredValue),
    ),
    sailBasis,
    lineItems,
    alerts,
    aiFindings,
    analysis,
    refundClaims,
    shipments: entry.entryShipments.map(({ shipment }) => ({
      id: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      // Reached through an entry link, which is itself arrival evidence.
      status: deriveShipmentStatus(shipment, true, todayIso()),
      documents: homeDocs("shipment", shipment.id),
    })),
    purchaseOrders: entry.entryPurchaseOrders.map(({ purchaseOrder }) => ({
      id: purchaseOrder.id,
      poNumber: purchaseOrder.poNumber,
      supplierName: purchaseOrder.supplierName,
      currency: purchaseOrder.currency,
      totalAmount: purchaseOrder.totalAmount,
      documents: homeDocs("purchase_order", purchaseOrder.id),
    })),
    invoices: entry.entryInvoices
      .map(({ invoice }) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        supplierName: invoice.supplierName,
        currency: invoice.currency,
        totalAmount: invoice.totalAmount,
        invoiceDate: invoice.invoiceDate,
        entryCount: invoiceEntryCount.get(invoice.id) ?? 1,
        documents: homeDocs("invoice", invoice.id),
      }))
      .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber)),
    documents: documentRows
      .filter((d) => d.entityType === "entry")
      .map((d) => ({
        id: d.id,
        fileName: d.fileName,
        docType: d.docType,
        fileSize: d.fileSize,
        created: d.created,
      })),
    entryPaperwork: homeDocs("entry", entryId),
  };
}
