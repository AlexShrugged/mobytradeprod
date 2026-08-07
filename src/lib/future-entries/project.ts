// Future entries: the derived projection of shipments that are on the water
// (or booked) with no customs entry yet — what the Entries page shows above
// the real rows. Pure, per doctrine: computed on read from shipments, their
// POs, and reference data; never stored (schema.ts says so where the entry
// tables are declared). Callers (queries/entries.ts) load the rows.
//
// The money here is an ESTIMATE and every consumer must label it as such
// (Money estimate={true}): entered value comes from PO prices, duties from
// the calculator over committed catalog codes, and MPF/HMF from nominal
// rates — CBP's per-entry minimums and caps are unknowable pre-entry.

import { computeExpectedCharges, normalizeHts } from "../duty/calculator";
import { HMF_RATE, MPF_RATE } from "../duty/fees";
import { resolveSailInfo } from "../duty/sail";
import type { ReferenceData, SailBasis, SailInfo } from "../duty/types";
import { deriveShipmentStatus } from "../shipments/status";
import { classifyShipment, type ImpactMeasure } from "../tariff-sync/impact";

export type ProjectableShipment = {
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
};

export type ProjectablePoLine = {
  sku: string | null;
  description: string | null;
  /** Origin as logged on the PO line itself — the strongest signal. */
  countryOfOrigin: string | null;
  quantity: string | null; // numeric string, as drizzle returns it
  unitPrice: string | null;
  totalPrice: string | null;
  part: {
    status: string;
    htsCode: string | null;
    htsCodeProvisional: boolean;
    /** The part's (vendor, COO) sourcing rows. */
    sources: { vendorId: string; countryOfOrigin: string | null }[];
  } | null;
};

export type ProjectablePurchaseOrder = {
  id: string;
  poNumber: string;
  supplierName: string | null;
  /** Resolved header vendor — picks the matching part source for COO. */
  vendorId: string | null;
  orderDate: string | null;
  currency: string;
  totalAmount: string | null;
  lines: ProjectablePoLine[];
};

export type EstimatedLine = {
  sku: string | null;
  description: string | null;
  /** The committed catalog code the estimate rests on; null = no committed
   *  code (draft part, provisional code, or no part) — not estimable. */
  htsCode: string | null;
  countryOfOrigin: string | null;
  quantity: number | null;
  enteredValueCents: number | null; // PO unit price × qty (total as fallback)
  baseDutyCents: number | null;
  additionalDutiesCents: number | null;
};

export type FutureEntry = {
  id: string; // "future:" + shipmentId — never collides with entry uuids
  projectedEntryDate: string | null; // the shipment's ETA
  shipment: ProjectableShipment;
  purchaseOrders: ProjectablePurchaseOrder[];
  estimatedLines: EstimatedLine[];
  estimatedEnteredValueCents: number | null;
  estimatedBaseDutyCents: number | null;
  estimatedAdditionalDutiesCents: number | null;
  /** Nominal-rate fees, labeled estimates (see module header). */
  estimatedMpfCents: number | null;
  estimatedHmfCents: number | null; // null off ocean — HMF is a harbor fee
  /** base + additional + nominal MPF/HMF; null when no line produced a duty
   *  component (an entered value alone is not a duty estimate). */
  estimatedDutiesCents: number | null;
  sailInfo: SailInfo;
  sailBasis: SailBasis;
  /** The savings-clause deadline: entering by this date avoids a
   *  sail-conditioned measure that would otherwise apply. The amber chip. */
  deadline: { measureName: string; enteredBy: string } | null;
};

export type ProjectionInput = {
  shipments: (ProjectableShipment & {
    purchaseOrders: ProjectablePurchaseOrder[];
  })[];
  /** Shipment ids that already have an entry_shipments row — their entry
   *  exists (even undated), so they are never projected. */
  enteredShipmentIds: ReadonlySet<string>;
  /** Sail-conditioned measure windows, for the deadline chip. */
  sailMeasures: ImpactMeasure[];
  ref: ReferenceData;
  today: string; // ISO date
};

const centsOf = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

// Worst-wins merge across lines, mirroring how the auditor reports a single
// entry-level sail assumption.
const BASIS_RANK: Record<Exclude<SailBasis, null>, number> = {
  exact: 0,
  estimated: 1,
  assumed: 2,
};
function worseBasis(a: SailBasis, b: SailBasis): SailBasis {
  if (a === null) return b;
  if (b === null) return a;
  return BASIS_RANK[b] > BASIS_RANK[a] ? b : a;
}

/**
 * Projected line COO preference: the PO line's own declared origin wins;
 * else the (part, PO-vendor) source row; else the part's single source when
 * exactly one exists (unambiguous); else unknown — and country-gated
 * measures silently drop out of the estimate, today's degradation. Draft
 * parts contribute nothing: their sources are quote claims.
 */
export function resolveProjectedCoo(
  declared: string | null,
  poVendorId: string | null,
  part: {
    status: string;
    sources: { vendorId: string; countryOfOrigin: string | null }[];
  } | null,
): string | null {
  if (declared !== null) return declared;
  if (!part || part.status === "draft") return null;
  if (poVendorId !== null) {
    const vendorSource = part.sources.find((s) => s.vendorId === poVendorId);
    if (vendorSource?.countryOfOrigin) return vendorSource.countryOfOrigin;
  }
  if (part.sources.length === 1) return part.sources[0].countryOfOrigin;
  return null;
}

/**
 * One FutureEntry per shipment that is still headed for customs: no
 * entry_shipments row and a derived status short of "arrived" (booked or
 * in transit — see shipments/status.ts; an ETA that has passed means the
 * goods are at port and past projecting).
 */
export function projectFutureEntries(input: ProjectionInput): FutureEntry[] {
  const projected = input.shipments
    .filter(
      (s) =>
        !input.enteredShipmentIds.has(s.id) &&
        deriveShipmentStatus(s, false, input.today) !== "arrived",
    )
    .map((s) => projectOne(s, input));

  // Soonest arrival first; ETA-less bookings sink to the bottom.
  return projected.sort(
    (a, b) =>
      (a.projectedEntryDate ?? "9999-12-31").localeCompare(
        b.projectedEntryDate ?? "9999-12-31",
      ) || a.shipment.shipmentNumber.localeCompare(b.shipment.shipmentNumber),
  );
}

function projectOne(
  shipment: ProjectableShipment & {
    purchaseOrders: ProjectablePurchaseOrder[];
  },
  input: ProjectionInput,
): FutureEntry {
  const sail = resolveSailInfo([shipment]);
  // The calculator needs an entry date; eta ?? today mirrors
  // classifyShipment's assumedEntry for in-transit goods.
  const assumedEntryDate = shipment.eta ?? input.today;

  let sailBasis: SailBasis = null;
  const estimatedLines: EstimatedLine[] = shipment.purchaseOrders.flatMap(
    (po) =>
      po.lines.map((line): EstimatedLine => {
        const quantity = line.quantity === null ? null : Number(line.quantity);
        const unitPriceCents = centsOf(line.unitPrice);
        const enteredValueCents =
          quantity !== null && unitPriceCents !== null
            ? Math.round(quantity * unitPriceCents)
            : centsOf(line.totalPrice);

        // Mirror the auditor's guard: a provisional (auto-selected,
        // unreviewed) code never drives money, and nothing on a draft part
        // is a committed fact — treat both as codeless.
        const committed =
          line.part &&
          line.part.status !== "draft" &&
          !line.part.htsCodeProvisional
            ? line.part
            : null;
        const htsCode = committed?.htsCode ?? null;
        const countryOfOrigin = resolveProjectedCoo(
          line.countryOfOrigin,
          po.vendorId,
          line.part,
        );

        let baseDutyCents: number | null = null;
        let additionalDutiesCents: number | null = null;
        if (htsCode !== null && enteredValueCents !== null) {
          const expected = computeExpectedCharges(
            {
              htsDigits: normalizeHts(htsCode),
              countryOfOrigin,
              enteredValueCents,
              entryDate: assumedEntryDate,
              sail,
            },
            input.ref,
          );
          baseDutyCents = expected.baseDuty?.amountCents ?? null;
          additionalDutiesCents = expected.measures.reduce(
            (sum, m) => sum + m.amountCents,
            0,
          );
          sailBasis = worseBasis(sailBasis, expected.sailBasis);
        }

        return {
          sku: line.sku,
          description: line.description,
          htsCode,
          countryOfOrigin,
          quantity,
          enteredValueCents,
          baseDutyCents,
          additionalDutiesCents,
        };
      }),
  );

  const pricedLines = estimatedLines.filter(
    (l) => l.enteredValueCents !== null,
  );
  const estimatedEnteredValueCents =
    pricedLines.length === 0
      ? null
      : pricedLines.reduce((sum, l) => sum + (l.enteredValueCents ?? 0), 0);

  const dutyLines = estimatedLines.filter(
    (l) => l.baseDutyCents !== null || l.additionalDutiesCents !== null,
  );
  const hasDuty = dutyLines.length > 0;
  const estimatedBaseDutyCents = hasDuty
    ? dutyLines.reduce((sum, l) => sum + (l.baseDutyCents ?? 0), 0)
    : null;
  const estimatedAdditionalDutiesCents = hasDuty
    ? dutyLines.reduce((sum, l) => sum + (l.additionalDutiesCents ?? 0), 0)
    : null;

  // Nominal MPF/HMF on the estimated entered value, labeled estimates —
  // HMF only on ocean freight (it funds harbor maintenance).
  const estimatedMpfCents =
    estimatedEnteredValueCents === null
      ? null
      : Math.round(MPF_RATE * estimatedEnteredValueCents);
  const estimatedHmfCents =
    estimatedEnteredValueCents === null || shipment.mode !== "ocean"
      ? null
      : Math.round(HMF_RATE * estimatedEnteredValueCents);

  const estimatedDutiesCents = hasDuty
    ? (estimatedBaseDutyCents ?? 0) +
      (estimatedAdditionalDutiesCents ?? 0) +
      (estimatedMpfCents ?? 0) +
      (estimatedHmfCents ?? 0)
    : null;

  // The savings-clause deadline: the first sail-conditioned measure whose
  // window would open on this shipment reports the last safe entry date.
  let deadline: FutureEntry["deadline"] = null;
  for (const m of input.sailMeasures) {
    const c = classifyShipment(shipment, m, input.today);
    if (typeof c === "object") {
      deadline = { measureName: m.name, enteredBy: c.sparedIfEnteredBy };
      break;
    }
  }

  const { purchaseOrders, ...shipmentOnly } = shipment;
  return {
    id: `future:${shipment.id}`,
    projectedEntryDate: shipment.eta,
    shipment: shipmentOnly,
    purchaseOrders,
    estimatedLines,
    estimatedEnteredValueCents,
    estimatedBaseDutyCents,
    estimatedAdditionalDutiesCents,
    estimatedMpfCents,
    estimatedHmfCents,
    estimatedDutiesCents,
    sailInfo: sail,
    sailBasis,
    deadline,
  };
}
