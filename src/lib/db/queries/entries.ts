import "server-only";

import { and, count, desc, eq, isNotNull, or } from "drizzle-orm";

import type { OpenAlertCounts } from "@/components/entries/audit-badge";
import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import {
  computeAuthorityBreakdown,
  effectiveDutyRate,
  type BucketTotal,
} from "@/lib/duty/authority";
import { computeExpectedCharges } from "@/lib/duty/calculator";
import { loadReferenceData } from "@/lib/duty/reference";
import { resolveSailInfo } from "@/lib/duty/sail";
import type { SailBasis } from "@/lib/duty/types";
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
  status: string;
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

export async function getEntries(): Promise<EntryRow[]> {
  const orgId = await getCurrentOrgId();

  const [rows, lineCounts, alertCounts, linkedClaims, sailWindows] =
    await Promise.all([
      db.query.entries.findMany({
        where: eq(schema.entries.orgId, orgId),
        orderBy: desc(schema.entries.entryDate),
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
      }),
      db
        .select({ entryId: schema.entryLineItems.entryId, value: count() })
        .from(schema.entryLineItems)
        .where(eq(schema.entryLineItems.orgId, orgId))
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
          ),
        )
        .groupBy(schema.auditAlerts.entryId, schema.auditAlerts.severity),
      db.query.refundClaims.findMany({
        where: and(
          eq(schema.refundClaims.orgId, orgId),
          isNotNull(schema.refundClaims.entryId),
        ),
        columns: {
          entryId: true,
          claimStatus: true,
          refundStatus: true,
          refundClassAmount: true,
          refundInterestAmount: true,
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
  // When an entry has several claims, surface the stage of the largest one.
  const stageByEntry = new Map<string, { stage: RefundStage; cents: number }>();
  for (const c of linkedClaims) {
    if (!c.entryId) continue;
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

  return rows.map((entry) => ({
    kind: "entry" as const,
    id: entry.id,
    entryNumber: entry.entryNumber,
    entryDate: entry.entryDate,
    portOfEntry: entry.portOfEntry,
    entryType: entry.entryType,
    status: entry.status,
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
      status: shipment.status,
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
      status: purchaseOrder.status,
    })),
  }));
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
            purchaseOrder: { with: { lines: { with: { part: true } } } },
          },
        },
      },
    }),
    db
      .select({ shipmentId: schema.entryShipments.shipmentId })
      .from(schema.entryShipments)
      .where(eq(schema.entryShipments.orgId, orgId)),
    loadSailWindows(),
    loadReferenceData(db),
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
      status: s.status,
      purchaseOrders: s.shipmentPurchaseOrders.map(({ purchaseOrder }) => ({
        id: purchaseOrder.id,
        poNumber: purchaseOrder.poNumber,
        supplierName: purchaseOrder.supplierName,
        orderDate: purchaseOrder.orderDate,
        currency: purchaseOrder.currency,
        totalAmount: purchaseOrder.totalAmount,
        status: purchaseOrder.status,
        lines: purchaseOrder.lines.map((l) => ({
          sku: l.sku,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          totalPrice: l.totalPrice,
          part: l.part
            ? {
                status: l.part.status,
                htsCode: l.part.htsCode,
                htsCodeProvisional: l.part.htsCodeProvisional,
                countryOfOrigin: l.part.countryOfOrigin,
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
        status: f.shipment.status,
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
      status: po.status,
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
  rate: number;
  expectedAmount: number; // dollars
};

export type LineItemDetail = {
  id: string;
  lineNumber: number;
  sku: string | null;
  description: string | null;
  htsCode: string;
  countryOfOrigin: string | null;
  quantity: string | null;
  unitValue: string | null;
  enteredValue: string;
  partId: string | null;
  /** The committed catalog code; null when absent or merely provisional. */
  catalogHtsCode: string | null;
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
  lineNumber: number | null;
  /** The catalog part behind the flagged line — the jump into HTS review. */
  partId: string | null;
  resolutionNote: string | null;
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
  refundClaims: RefundClaimDetail[];
  shipments: { id: string; shipmentNumber: string; status: string }[];
  purchaseOrders: {
    id: string;
    poNumber: string;
    supplierName: string | null;
    currency: string;
    totalAmount: string | null;
    status: string;
  }[];
  documents: EntryDocument[];
};

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
const BASIS_RANK = { exact: 0, estimated: 1, assumed: 2 } as const;

export async function getEntryDetail(
  entryId: string,
): Promise<EntryDetail | null> {
  const orgId = await getCurrentOrgId();

  const entry = await db.query.entries.findFirst({
    where: eq(schema.entries.id, entryId),
    with: {
      lineItems: {
        with: { part: true, charges: true },
        orderBy: (li, { asc }) => [asc(li.lineNumber)],
      },
      auditAlerts: true,
      refundClaims: true,
      entryShipments: { with: { shipment: true } },
      entryPurchaseOrders: { with: { purchaseOrder: true } },
    },
  });
  if (!entry || entry.orgId !== orgId) return null;

  const [ref, documentRows] = await Promise.all([
    loadReferenceData(db),
    // Source documents via provenance links; raw_extraction never leaves
    // the server (it can be multiple MB per row).
    db
      .select({
        id: schema.documents.id,
        fileName: schema.documents.fileName,
        docType: schema.documents.docType,
        fileSize: schema.documents.fileSize,
        created: schema.documentLinks.created,
      })
      .from(schema.documentLinks)
      .innerJoin(
        schema.documents,
        eq(schema.documentLinks.documentId, schema.documents.id),
      )
      .where(
        and(
          eq(schema.documentLinks.orgId, orgId),
          eq(schema.documentLinks.entityType, "entry"),
          eq(schema.documentLinks.entityId, entryId),
        ),
      )
      .orderBy(desc(schema.documents.uploadedAt)),
  ]);

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
          expectedAmount = em.amountCents / 100;
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
            expectedAmount: m.amountCents / 100,
          }))
      : [];

    // Mirror the auditor's provisional guard: an unreviewed auto-selected
    // code never drives the mismatch badge, only a neutral provisional one.
    const catalogHtsCode =
      li.part && !li.part.htsCodeProvisional ? li.part.htsCode : null;
    const catalogProvisionalCode =
      li.part && li.part.htsCodeProvisional ? li.part.htsCode : null;
    const lineAlerts = entry.auditAlerts.filter(
      (a) => a.status === "open" && a.lineItemId === li.id,
    );
    const openAlerts: OpenAlertCounts = { ...EMPTY_ALERTS };
    for (const a of lineAlerts) openAlerts[a.severity] += 1;

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
      quantity: li.quantity,
      unitValue: li.unitValue,
      enteredValue: li.enteredValue,
      partId: li.partId,
      catalogHtsCode,
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
    status: entry.status,
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
    ),
    effectiveDutyRate: effectiveDutyRate(
      dutyCents,
      centsOf(entry.totalEnteredValue),
    ),
    sailBasis,
    lineItems,
    alerts,
    refundClaims,
    shipments: entry.entryShipments.map(({ shipment }) => ({
      id: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      status: shipment.status,
    })),
    purchaseOrders: entry.entryPurchaseOrders.map(({ purchaseOrder }) => ({
      id: purchaseOrder.id,
      poNumber: purchaseOrder.poNumber,
      supplierName: purchaseOrder.supplierName,
      currency: purchaseOrder.currency,
      totalAmount: purchaseOrder.totalAmount,
      status: purchaseOrder.status,
    })),
    documents: documentRows.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      docType: d.docType,
      fileSize: d.fileSize,
      created: d.created,
    })),
  };
}
