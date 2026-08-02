// Which in-transit shipments does a tariff change touch? Pure
// classification over (shipment sail/eta dates × measure windows),
// computed on demand — same doctrine as expected charges: derived data is
// never stored, so it can never go stale.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";

import * as schema from "../db/schema";
import type { DbClient } from "../duty/reference";

export type ImpactShipment = {
  id: string;
  shipmentNumber: string;
  billOfLading: string | null;
  sailedOnBoardDate: string | null;
  etd: string | null;
  eta: string | null;
  status: string;
  /** Sum of linked PO totals, cents — the exposure basis. */
  poTotalCents: number;
};

export type ImpactMeasure = {
  id: string;
  name: string;
  ch99Code: string | null;
  rate: number | null;
  scope: schema.MeasureScopeValue;
  effectiveDate: string;
  endDate: string | null;
  sailedOnOrAfter: string | null;
  sailedOnOrBefore: string | null;
};

export type ImpactClassification =
  | "affected"
  | { sparedIfEnteredBy: string }
  | "spared"
  | "unknown";

export type ImpactRow = {
  shipmentId: string;
  shipmentNumber: string;
  sailDate: string | null;
  sailEstimated: boolean;
  eta: string | null;
  perMeasure: {
    measureId: string;
    measureName: string;
    classification: ImpactClassification;
    /** rate × PO total for all_products measures; null when HTS-level
     *  scope makes pre-entry money unknowable. */
    exposureCents: number | null;
  }[];
};

/** Classify one shipment against one measure window. `assumedEntry` is
 *  eta ?? today — in-transit goods have no entry date yet. */
export function classifyShipment(
  shipment: Pick<ImpactShipment, "sailedOnBoardDate" | "etd" | "eta">,
  measure: ImpactMeasure,
  today: string,
): ImpactClassification {
  const sailDate = shipment.sailedOnBoardDate ?? shipment.etd;
  const assumedEntry = shipment.eta ?? today;

  // Sail conditions first: a provable miss spares the shipment outright.
  if (measure.sailedOnOrAfter !== null) {
    if (sailDate === null) return "unknown";
    if (sailDate < measure.sailedOnOrAfter) return "spared";
  }
  if (measure.sailedOnOrBefore !== null) {
    if (sailDate === null) return "unknown";
    if (sailDate > measure.sailedOnOrBefore) return "spared";
  }

  // Entry window vs the assumed entry date.
  if (measure.endDate !== null && assumedEntry > measure.endDate) return "spared";
  if (assumedEntry >= measure.effectiveDate) return "affected";

  // Entering before the window opens. If the window WILL open and the sail
  // conditions already hold, slipping past the deadline flips the outcome —
  // that deadline is the actionable fact.
  return { sparedIfEnteredBy: dayBeforeIso(measure.effectiveDate) };
}

export function computeImpact(
  shipments: ImpactShipment[],
  measures: ImpactMeasure[],
  today: string,
): ImpactRow[] {
  const rows: ImpactRow[] = [];
  for (const s of shipments) {
    const perMeasure = measures.map((m) => {
      const classification = classifyShipment(s, m, today);
      const exposureCents =
        classification !== "spared" &&
        m.scope === "all_products" &&
        m.rate !== null &&
        s.poTotalCents > 0
          ? Math.round(m.rate * s.poTotalCents)
          : null;
      return {
        measureId: m.id,
        measureName: m.name,
        classification,
        exposureCents,
      };
    });
    // Only shipments the change actually concerns make the report.
    if (perMeasure.some((p) => p.classification !== "spared")) {
      rows.push({
        shipmentId: s.id,
        shipmentNumber: s.shipmentNumber,
        sailDate: s.sailedOnBoardDate ?? s.etd,
        sailEstimated: s.sailedOnBoardDate === null && s.etd !== null,
        eta: s.eta,
        perMeasure: perMeasure.filter((p) => p.classification !== "spared"),
      });
    }
  }
  return rows;
}

/** In-transit = linked to no entry that has an entry_date (SHP-1008: no
 *  entry at all; a draft entry without a date still counts as in transit). */
export async function loadInTransitShipments(
  db: DbClient,
  orgId: string,
): Promise<ImpactShipment[]> {
  // Excluded: any shipment already behind a DATED entry — customs has its
  // date, so the on-the-water question is settled for it.
  const withDatedEntry = (
    await db
      .selectDistinct({ shipmentId: schema.entryShipments.shipmentId })
      .from(schema.entryShipments)
      .innerJoin(
        schema.entries,
        eq(schema.entryShipments.entryId, schema.entries.id),
      )
      .where(
        and(
          eq(schema.entries.orgId, orgId),
          isNotNull(schema.entries.entryDate),
        ),
      )
  ).map((r) => r.shipmentId);

  const shipments = await db.query.shipments.findMany({
    where: and(
      eq(schema.shipments.orgId, orgId),
      withDatedEntry.length > 0
        ? notInArray(schema.shipments.id, withDatedEntry)
        : undefined,
    ),
    with: {
      shipmentPurchaseOrders: { with: { purchaseOrder: true } },
    },
  });

  return shipments.map((s) => ({
    id: s.id,
    shipmentNumber: s.shipmentNumber,
    billOfLading: s.billOfLading,
    sailedOnBoardDate: s.sailedOnBoardDate,
    etd: s.etd,
    eta: s.eta,
    status: s.status,
    poTotalCents: s.shipmentPurchaseOrders.reduce(
      (sum, spo) =>
        sum +
        (spo.purchaseOrder.totalAmount
          ? Math.round(Number(spo.purchaseOrder.totalAmount) * 100)
          : 0),
      0,
    ),
  }));
}

/** Load the measure windows an apply changed, in impact shape. */
export async function loadImpactMeasures(
  db: DbClient,
  measureIds: string[],
): Promise<ImpactMeasure[]> {
  if (measureIds.length === 0) return [];
  const measures = await db.query.tradeMeasures.findMany({
    where: inArray(schema.tradeMeasures.id, measureIds),
    with: { htsCodes: true },
  });
  return measures.map((m) => {
    const line = m.htsCodes.find((h) => !h.exemption) ?? null;
    return {
      id: m.id,
      name: m.name,
      ch99Code: line?.code ?? null,
      rate: line?.rate === null || line === null ? null : Number(line.rate),
      scope: m.scope,
      effectiveDate: m.effectiveDate,
      endDate: m.endDate,
      sailedOnOrAfter: m.sailedOnOrAfter,
      sailedOnOrBefore: m.sailedOnOrBefore,
    };
  });
}

function dayBeforeIso(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
