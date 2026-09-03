// The per-SKU sourcing comparison — every option a part can be bought
// under (the current (part, vendor) sources and every quote line, whatever
// its status) priced to a landed cost under one HTS basis and today's (or
// any date's) measures, cheapest marked. Pure: no DB, no IO, test-pinned.
// queries/parts.ts renders it; quotes/reconsider.ts diffs it before and
// after a tariff change to decide whether a human should look again.
//
// HTS basis: the committed catalog code when there is one; otherwise the
// classifier's provisional pick or its ranked candidates — a quote-created
// SKU has no code yet, only potential ones, and the comparison prices under
// the top candidate with the rest offered as alternatives. Never the
// supplier's own claimed code (reference only, doctrine).
//
// Relative imports on purpose — reachable from the tsx seed script.

import { normalizeHts } from "../duty/calculator";
import type { ReferenceData } from "../duty/types";
import { formatDate } from "../format";
import { computeEstimatedLandedCost } from "../landed-cost/estimate";
import type { LandedCost } from "../landed-cost/types";

export type ComparisonQuoteStatus =
  | "received"
  | "approved"
  | "rejected"
  | "superseded"
  | "applied";

export type ComparisonSourceInput = {
  sourceId: string;
  vendorId: string;
  vendorName: string;
  /** numeric column text; null = no official cost yet. */
  unitCost: string | null;
  countryOfOrigin: string | null;
};

export type ComparisonQuoteInput = {
  quoteLineId: string;
  vendorId: string | null;
  supplierName: string | null;
  quoteDate: string | null;
  status: ComparisonQuoteStatus;
  unitCost: string;
  currency: string;
  countryOfOrigin: string | null;
};

export type HtsCandidateInput = {
  code: string;
  codeDigits: string;
  confidence: number | null;
};

export type HtsBasisKind = "committed" | "provisional" | "candidate" | "none";

export type HtsBasisCode = {
  code: string;
  digits: string;
  confidence: number | null;
};

export type HtsBasis = {
  kind: HtsBasisKind;
  code: string | null;
  digits: string | null;
  confidence: number | null;
  /** Other potential codes (provisional/candidate bases only), rank order. */
  alternatives: HtsBasisCode[];
};

/** Which code prices the comparison. A committed code stands alone; a
 *  provisional auto-select leads its run's other candidates; with no code
 *  at all the ranked candidates lead. */
export function selectHtsBasis(
  part: { htsCode: string | null; htsCodeProvisional: boolean },
  candidates: HtsCandidateInput[],
): HtsBasis {
  const ranked: HtsBasisCode[] = candidates.map((c) => ({
    code: c.code,
    digits: c.codeDigits,
    confidence: c.confidence,
  }));
  if (part.htsCode !== null) {
    const digits = normalizeHts(part.htsCode);
    const match = ranked.find((c) => c.digits === digits) ?? null;
    return {
      kind: part.htsCodeProvisional ? "provisional" : "committed",
      code: part.htsCode,
      digits,
      confidence: match?.confidence ?? null,
      alternatives: part.htsCodeProvisional
        ? ranked.filter((c) => c.digits !== digits)
        : [],
    };
  }
  if (ranked.length > 0) {
    const [primary, ...rest] = ranked;
    return {
      kind: "candidate",
      code: primary.code,
      digits: primary.digits,
      confidence: primary.confidence,
      alternatives: rest,
    };
  }
  return { kind: "none", code: null, digits: null, confidence: null, alternatives: [] };
}

export type ComparisonOption = {
  /** "source:<sourceId>" | "quote:<quoteLineId>" — stable across reads. */
  key: string;
  kind: "source" | "quote";
  sourceId: string | null;
  quoteLineId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  /** "current" for a source row, else the quote line's status. */
  status: "current" | ComparisonQuoteStatus;
  quoteDate: string | null;
  unitCostCents: number | null;
  currency: string;
  countryOfOrigin: string | null;
  /** The org buys (or has decided to buy) under this option: an official
   *  source cost, or an approved/applied quote. */
  chosen: boolean;
  /** Ranks for cheapest: priced, and not a superseded (stale) quote. */
  eligible: boolean;
  landed: LandedCost | null;
  landedPerUnitCents: number | null;
  incomplete: boolean;
  cheapest: boolean;
  /** This option's landed minus the cheapest eligible option's, cents. */
  deltaVsCheapestCents: number | null;
};

export type QuoteComparison = {
  basis: HtsBasis;
  asOf: string;
  /** Cheapest first; unpriced and superseded options trail. */
  options: ComparisonOption[];
  cheapestKey: string | null;
  /** The cheapest CHOSEN option — what the org lands at today. */
  chosenKey: string | null;
  /** Eligible options with a landed figure. */
  comparableCount: number;
};

export type ComparisonInput = {
  part: { htsCode: string | null; htsCodeProvisional: boolean };
  candidates: HtsCandidateInput[];
  sources: ComparisonSourceInput[];
  quotes: ComparisonQuoteInput[];
};

const centsOf = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

const isUsd = (currency: string) => currency.trim().toUpperCase() === "USD";

/** Build the comparison under the part's basis (or an explicit basis
 *  digits string — the UI's alternative-code switch). */
export function buildQuoteComparison(
  input: ComparisonInput,
  ref: ReferenceData,
  asOf: string,
  opts: { basisDigits?: string | null } = {},
): QuoteComparison {
  const selected = selectHtsBasis(input.part, input.candidates);
  const basis = rebase(selected, opts.basisDigits ?? null);
  const sourceCooByVendor = new Map(
    input.sources.map((s) => [s.vendorId, s.countryOfOrigin]),
  );

  const price = (
    unitCostCents: number | null,
    coo: string | null,
  ): LandedCost | null =>
    basis.digits === null || unitCostCents === null
      ? null
      : computeEstimatedLandedCost(
          { unitCostCents, htsDigits: basis.digits, countryOfOrigin: coo },
          ref,
          asOf,
        );

  const options: ComparisonOption[] = [];

  for (const s of input.sources) {
    const unitCostCents = centsOf(s.unitCost);
    const landed = price(unitCostCents, s.countryOfOrigin);
    options.push({
      key: `source:${s.sourceId}`,
      kind: "source",
      sourceId: s.sourceId,
      quoteLineId: null,
      vendorId: s.vendorId,
      vendorName: s.vendorName,
      status: "current",
      quoteDate: null,
      unitCostCents,
      currency: "USD",
      countryOfOrigin: s.countryOfOrigin,
      chosen: unitCostCents !== null,
      eligible: landed !== null,
      landed,
      landedPerUnitCents: landed?.perUnitCents ?? null,
      incomplete: landed?.incomplete ?? false,
      cheapest: false,
      deltaVsCheapestCents: null,
    });
  }

  for (const q of input.quotes) {
    const unitCostCents = centsOf(q.unitCost);
    // Source costs are implicitly USD; a foreign-currency quote has no
    // comparable landed figure without FX (none exists here).
    const coo =
      q.countryOfOrigin ??
      (q.vendorId ? (sourceCooByVendor.get(q.vendorId) ?? null) : null);
    const landed = isUsd(q.currency) ? price(unitCostCents, coo) : null;
    options.push({
      key: `quote:${q.quoteLineId}`,
      kind: "quote",
      sourceId: null,
      quoteLineId: q.quoteLineId,
      vendorId: q.vendorId,
      vendorName: q.supplierName,
      status: q.status,
      quoteDate: q.quoteDate,
      unitCostCents,
      currency: q.currency.trim().toUpperCase(),
      countryOfOrigin: coo,
      chosen: q.status === "approved" || q.status === "applied",
      eligible: landed !== null && q.status !== "superseded",
      landed,
      landedPerUnitCents: landed?.perUnitCents ?? null,
      incomplete: landed?.incomplete ?? false,
      cheapest: false,
      deltaVsCheapestCents: null,
    });
  }

  const eligible = options.filter(
    (o) => o.eligible && o.landedPerUnitCents !== null,
  );
  const rank = (a: ComparisonOption, b: ComparisonOption) => {
    const byLanded =
      (a.landedPerUnitCents as number) - (b.landedPerUnitCents as number);
    if (byLanded !== 0) return byLanded;
    // Ties: what the org already buys under, then the catalog row, then a
    // stable key so two reads never disagree.
    if (a.chosen !== b.chosen) return a.chosen ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "source" ? -1 : 1;
    return a.key.localeCompare(b.key);
  };
  const cheapest = [...eligible].sort(rank)[0] ?? null;
  const chosen = [...eligible].filter((o) => o.chosen).sort(rank)[0] ?? null;

  if (cheapest) {
    for (const o of options) {
      if (o.eligible && o.landedPerUnitCents !== null) {
        o.deltaVsCheapestCents =
          o.landedPerUnitCents - (cheapest.landedPerUnitCents as number);
      }
    }
    cheapest.cheapest = true;
  }

  const sorted = [...options].sort((a, b) => {
    const aRanks = a.eligible && a.landedPerUnitCents !== null;
    const bRanks = b.eligible && b.landedPerUnitCents !== null;
    if (aRanks && bRanks) return rank(a, b);
    if (aRanks !== bRanks) return aRanks ? -1 : 1;
    // Unranked: priced-but-stale before unpriced, then key.
    if ((a.landedPerUnitCents === null) !== (b.landedPerUnitCents === null)) {
      return a.landedPerUnitCents === null ? 1 : -1;
    }
    return a.key.localeCompare(b.key);
  });

  return {
    basis,
    asOf,
    options: sorted,
    cheapestKey: cheapest?.key ?? null,
    chosenKey: chosen?.key ?? null,
    comparableCount: eligible.length,
  };
}

/** Re-point a basis at one of its alternative codes (the UI switch); an
 *  unknown digits string leaves the basis alone. */
function rebase(basis: HtsBasis, digits: string | null): HtsBasis {
  if (digits === null || basis.digits === digits) return basis;
  const pick = basis.alternatives.find((a) => a.digits === digits);
  if (!pick) return basis;
  const primary: HtsBasisCode = {
    code: basis.code as string,
    digits: basis.digits as string,
    confidence: basis.confidence,
  };
  return {
    kind: basis.kind,
    code: pick.code,
    digits: pick.digits,
    confidence: pick.confidence,
    alternatives: [primary, ...basis.alternatives.filter((a) => a !== pick)],
  };
}

// ---------------------------------------------------------- reconsider diff

export type ReconsiderSignal = {
  cheapestKey: string;
  previousCheapestKey: string | null;
  /** The cheapest chosen option after the change (null = nothing chosen). */
  chosenKey: string | null;
  /** What moving to the cheapest option saves per unit, after the change:
   *  against the chosen option when one exists and is not the cheapest,
   *  else against what was cheapest before. Always ≥ 1. */
  savingCents: number;
};

/**
 * Did a tariff change move the cheapest option? Fires only when the
 * cheapest key differs between the two comparisons (a change that leaves
 * the ranking alone, or a cheaper option the org already knew about and
 * passed on, is nothing new) and the move is worth at least a cent. Needs
 * two comparable options after the change — one option is nothing to
 * reconsider.
 */
export function diffComparisons(
  before: QuoteComparison,
  after: QuoteComparison,
): ReconsiderSignal | null {
  if (after.comparableCount < 2 || after.cheapestKey === null) return null;
  if (before.cheapestKey === after.cheapestKey) return null;

  const cheapest = after.options.find((o) => o.key === after.cheapestKey);
  if (!cheapest || cheapest.landedPerUnitCents === null) return null;

  const reference =
    after.chosenKey !== null && after.chosenKey !== after.cheapestKey
      ? after.options.find((o) => o.key === after.chosenKey)
      : before.cheapestKey !== null
        ? after.options.find((o) => o.key === before.cheapestKey)
        : undefined;
  if (!reference || reference.landedPerUnitCents === null) return null;

  const savingCents = reference.landedPerUnitCents - cheapest.landedPerUnitCents;
  if (savingCents < 1) return null;

  return {
    cheapestKey: after.cheapestKey,
    previousCheapestKey: before.cheapestKey,
    chosenKey: after.chosenKey,
    savingCents,
  };
}

// ------------------------------------------------------------ proposal

/** review_items.proposal for a quote_reconsider item — the denormalized
 *  display payload (same role as the classification ReviewProposal). */
export type QuoteReconsiderProposal = {
  sku: string;
  partName: string;
  changeLabel: string;
  asOfBefore: string;
  asOfAfter: string;
  basisKind: HtsBasisKind;
  basisCode: string | null;
  cheapest: { key: string; label: string; landedCents: number };
  previousCheapest: { key: string; label: string } | null;
  chosen: { key: string; label: string; landedCents: number } | null;
  savingCents: number;
  options: {
    key: string;
    label: string;
    status: ComparisonOption["status"];
    beforeCents: number | null;
    afterCents: number | null;
  }[];
};

export function optionLabel(o: ComparisonOption): string {
  const name = o.vendorName ?? "Unknown supplier";
  return o.kind === "quote" && o.quoteDate
    ? `${name} · ${formatDate(o.quoteDate)}`
    : name;
}

export function buildReconsiderProposal(
  meta: { sku: string; partName: string; changeLabel: string },
  before: QuoteComparison,
  after: QuoteComparison,
  signal: ReconsiderSignal,
): QuoteReconsiderProposal {
  const beforeByKey = new Map(before.options.map((o) => [o.key, o]));
  const cheapest = after.options.find((o) => o.key === signal.cheapestKey)!;
  const chosen =
    signal.chosenKey === null
      ? null
      : (after.options.find((o) => o.key === signal.chosenKey) ?? null);
  const previous =
    signal.previousCheapestKey === null
      ? null
      : (after.options.find((o) => o.key === signal.previousCheapestKey) ??
        beforeByKey.get(signal.previousCheapestKey) ??
        null);
  return {
    sku: meta.sku,
    partName: meta.partName,
    changeLabel: meta.changeLabel,
    asOfBefore: before.asOf,
    asOfAfter: after.asOf,
    basisKind: after.basis.kind,
    basisCode: after.basis.code,
    cheapest: {
      key: cheapest.key,
      label: optionLabel(cheapest),
      landedCents: cheapest.landedPerUnitCents as number,
    },
    previousCheapest: previous
      ? { key: previous.key, label: optionLabel(previous) }
      : null,
    chosen:
      chosen && chosen.landedPerUnitCents !== null
        ? {
            key: chosen.key,
            label: optionLabel(chosen),
            landedCents: chosen.landedPerUnitCents,
          }
        : null,
    savingCents: signal.savingCents,
    options: after.options.map((o) => ({
      key: o.key,
      label: optionLabel(o),
      status: o.status,
      beforeCents: beforeByKey.get(o.key)?.landedPerUnitCents ?? null,
      afterCents: o.landedPerUnitCents,
    })),
  };
}
