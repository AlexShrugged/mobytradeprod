// Cross-entry aggregation of actual landed cost by SKU. Pure and DB-free:
// the query layer fetches and filters (org scope, entry status), this module
// only aggregates. Grouping key is the part link when present, with a
// sku-string fallback for lines that never matched the catalog — money on
// unmatched lines must not vanish from the SKU surface.

import { chargeKind, type ActualChargeInput } from "./actual";

export type RollupLine = {
  partId: string | null;
  sku: string | null;
  entryId: string;
  entryNumber: string;
  entryDate: string | null; // ISO date
  lineNumber: number;
  quantity: number | null;
  enteredValueCents: number;
  charges: ActualChargeInput[];
};

export type SkuRollupMonth = {
  month: string; // "YYYY-MM"
  quantity: number;
  landedCents: number;
  perUnitCents: number | null;
};

export type SkuRollup = {
  key: string; // partId, or `sku:${sku}` for catalog-unmatched lines
  partId: string | null;
  sku: string;
  quantity: number; // sum over lines that carry a quantity
  merchandiseCents: number;
  dutyCents: number;
  feeCents: number;
  landedCents: number;
  // Weighted per-unit over the lines that carry a positive quantity only.
  perUnitCents: number | null;
  qtyCoverage: "full" | "partial"; // partial = some lines lacked quantity
  entryCount: number;
  lineCount: number;
  firstEntryDate: string | null;
  lastEntryDate: string | null;
  monthly: SkuRollupMonth[]; // ascending by month; dateless lines omitted
  latest: {
    entryDate: string | null;
    entryNumber: string;
    perUnitCents: number | null;
  };
};

type Bucket = {
  key: string;
  partId: string | null;
  sku: string;
  quantity: number;
  merchandiseCents: number;
  dutyCents: number;
  feeCents: number;
  qtyLandedCents: number; // landed cents on positive-quantity lines
  qtyUnits: number;
  missingQty: boolean;
  entryIds: Set<string>;
  lineCount: number;
  firstEntryDate: string | null;
  lastEntryDate: string | null;
  months: Map<string, { quantity: number; landedCents: number }>;
  latestLine: RollupLine | null;
  latestLandedCents: number;
};

function lineCents(line: RollupLine): {
  duty: number;
  fee: number;
  landed: number;
} {
  let duty = 0;
  let fee = 0;
  for (const c of line.charges) {
    if (chargeKind(c.chargeType) === "duty") duty += c.amountCents;
    else fee += c.amountCents;
  }
  return { duty, fee, landed: line.enteredValueCents + duty + fee };
}

/** Later entry date wins; a dated line always beats an undated one; ties go
 * to the higher line number so the ordering is deterministic. */
function isLater(candidate: RollupLine, incumbent: RollupLine | null): boolean {
  if (incumbent === null) return true;
  if (candidate.entryDate === incumbent.entryDate) {
    return candidate.lineNumber > incumbent.lineNumber;
  }
  if (candidate.entryDate === null) return false;
  if (incumbent.entryDate === null) return true;
  return candidate.entryDate > incumbent.entryDate;
}

export function rollupBySku(lines: RollupLine[]): SkuRollup[] {
  const buckets = new Map<string, Bucket>();

  for (const line of lines) {
    const key =
      line.partId ?? (line.sku !== null ? `sku:${line.sku}` : null);
    // Neither a part link nor a SKU string: nothing to group by. The query
    // layer keeps this money in org-level totals.
    if (key === null) continue;

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        partId: line.partId,
        sku: line.sku ?? "",
        quantity: 0,
        merchandiseCents: 0,
        dutyCents: 0,
        feeCents: 0,
        qtyLandedCents: 0,
        qtyUnits: 0,
        missingQty: false,
        entryIds: new Set(),
        lineCount: 0,
        firstEntryDate: null,
        lastEntryDate: null,
        months: new Map(),
        latestLine: null,
        latestLandedCents: 0,
      };
      buckets.set(key, bucket);
    }
    if (bucket.sku === "" && line.sku !== null) bucket.sku = line.sku;

    const cents = lineCents(line);
    bucket.merchandiseCents += line.enteredValueCents;
    bucket.dutyCents += cents.duty;
    bucket.feeCents += cents.fee;
    bucket.entryIds.add(line.entryId);
    bucket.lineCount += 1;

    if (line.quantity !== null && line.quantity > 0) {
      bucket.quantity += line.quantity;
      bucket.qtyLandedCents += cents.landed;
      bucket.qtyUnits += line.quantity;
    } else {
      bucket.missingQty = true;
    }

    if (line.entryDate !== null) {
      if (bucket.firstEntryDate === null || line.entryDate < bucket.firstEntryDate) {
        bucket.firstEntryDate = line.entryDate;
      }
      if (bucket.lastEntryDate === null || line.entryDate > bucket.lastEntryDate) {
        bucket.lastEntryDate = line.entryDate;
      }
      const month = line.entryDate.slice(0, 7);
      const m = bucket.months.get(month) ?? { quantity: 0, landedCents: 0 };
      m.landedCents += cents.landed;
      if (line.quantity !== null && line.quantity > 0) m.quantity += line.quantity;
      bucket.months.set(month, m);
    }

    if (isLater(line, bucket.latestLine)) {
      bucket.latestLine = line;
      bucket.latestLandedCents = cents.landed;
    }
  }

  const rollups: SkuRollup[] = [];
  for (const b of buckets.values()) {
    const latest = b.latestLine;
    rollups.push({
      key: b.key,
      partId: b.partId,
      sku: b.sku,
      quantity: b.quantity,
      merchandiseCents: b.merchandiseCents,
      dutyCents: b.dutyCents,
      feeCents: b.feeCents,
      landedCents: b.merchandiseCents + b.dutyCents + b.feeCents,
      perUnitCents:
        b.qtyUnits > 0 ? Math.round(b.qtyLandedCents / b.qtyUnits) : null,
      qtyCoverage: b.missingQty ? "partial" : "full",
      entryCount: b.entryIds.size,
      lineCount: b.lineCount,
      firstEntryDate: b.firstEntryDate,
      lastEntryDate: b.lastEntryDate,
      monthly: [...b.months.entries()]
        .sort(([a], [z]) => a.localeCompare(z))
        .map(([month, m]) => ({
          month,
          quantity: m.quantity,
          landedCents: m.landedCents,
          perUnitCents:
            m.quantity > 0 ? Math.round(m.landedCents / m.quantity) : null,
        })),
      latest: {
        entryDate: latest?.entryDate ?? null,
        entryNumber: latest?.entryNumber ?? "",
        perUnitCents:
          latest !== null && latest.quantity !== null && latest.quantity > 0
            ? Math.round(b.latestLandedCents / latest.quantity)
            : null,
      },
    });
  }

  // Most landed cost first — the natural default for a north-star table.
  rollups.sort((a, z) => z.landedCents - a.landedCents);
  return rollups;
}
