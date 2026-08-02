// The pure decision logic behind quotes/service.ts — quote↔PO matching,
// winner selection, auto-supersede selection, and the part-field diff an
// application implies. No DB, no IO, test-pinned: the service only executes
// what these functions decide, so the semantics that matter (price
// tolerance, supplier gating, "approved lines are never auto-superseded",
// "HTS never flows from a quote") are all provable here without a database.
//
// Relative imports on purpose — reachable from the tsx seed script.

/** Casefolded, trimmed supplier key; empty/whitespace collapses to null. */
export function normalizeSupplier(name: string | null | undefined): string | null {
  const key = name?.trim().toLowerCase() ?? "";
  return key === "" ? null : key;
}

export type PoLineMatchInput = {
  /** purchase_order_lines.part_id — null never matches. */
  partId: string | null;
  /** Numeric unit price; null never matches (no price to agree with). */
  unitPrice: number | null;
  // --- PO header context ---
  orderDate: string | null; // ISO date
  currency: string;
  supplierName: string | null;
};

export type QuoteLineMatchInput = {
  partId: string;
  unitCost: number;
  currency: string;
  // --- sheet context ---
  quoteDate: string | null; // ISO date
  supplierName: string | null;
};

// Floating-point guard for the tolerance boundary: a diff exactly AT the
// tolerance must match even when binary representation lands a hair over.
const EPSILON = 1e-9;

/**
 * Does this PO line confirm this approved quote line? The rule (settled
 * 2026-08-02):
 *   - same part;
 *   - the PO was placed on/after the quote's date — unknown dates on either
 *     side never block (the price agreement is the strong signal);
 *   - price agreement: |po.unitPrice − quote.unitCost| ≤ max($0.01, 0.5% of
 *     the quote), same currency only;
 *   - supplier names (trim/casefold) gate only when BOTH sides carry one —
 *     a PO without a supplier does not block.
 */
export function poLineMatchesQuote(
  po: PoLineMatchInput,
  quote: QuoteLineMatchInput,
): boolean {
  if (po.partId === null || po.partId !== quote.partId) return false;

  if (
    quote.quoteDate !== null &&
    po.orderDate !== null &&
    po.orderDate < quote.quoteDate
  ) {
    return false;
  }

  if (po.unitPrice === null) return false;
  if (
    po.currency.trim().toUpperCase() !== quote.currency.trim().toUpperCase()
  ) {
    return false;
  }
  const tolerance = Math.max(0.01, quote.unitCost * 0.005);
  if (Math.abs(po.unitPrice - quote.unitCost) > tolerance + EPSILON) {
    return false;
  }

  const poSupplier = normalizeSupplier(po.supplierName);
  const quoteSupplier = normalizeSupplier(quote.supplierName);
  if (
    poSupplier !== null &&
    quoteSupplier !== null &&
    poSupplier !== quoteSupplier
  ) {
    return false;
  }

  return true;
}

export type QuoteCandidate = {
  /** quote_lines.id — uuidv7 sorts by creation time, the final tiebreak. */
  id: string;
  createdAt: Date | string;
  /** Sheet quote_date; undated sheets rank behind any dated one. */
  quoteDate: string | null;
};

/**
 * Most-recent approved line wins: newest sheet quote_date first (undated
 * sheets last), then newest line by createdAt, then by id. Pure ranking —
 * callers pass only lines that already passed poLineMatchesQuote.
 */
export function pickWinningQuote<T extends QuoteCandidate>(
  candidates: T[],
): T | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const byDate = (b.quoteDate ?? "").localeCompare(a.quoteDate ?? "");
    if (byDate !== 0) return byDate;
    const byCreated =
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (byCreated !== 0) return byCreated;
    return b.id.localeCompare(a.id);
  })[0];
}

export type SupersedeCandidate = {
  id: string;
  partId: string;
  status: string;
  /** The candidate line's SHEET supplier. */
  supplierName: string | null;
};

/**
 * Which existing lines a newly ingested one pushes aside: RECEIVED lines
 * for the same (part, supplier). Approved/applied/rejected lines are human
 * decisions and are NEVER auto-superseded — the UI flags "newer quote
 * exists" instead. Suppliers compare trim/casefolded; an unnamed sheet only
 * supersedes other unnamed sheets (it cannot displace a named supplier's
 * standing quote).
 */
export function selectSupersededLineIds(
  incoming: { id: string; partId: string; supplierName: string | null },
  existing: SupersedeCandidate[],
): string[] {
  const supplier = normalizeSupplier(incoming.supplierName);
  return existing
    .filter(
      (line) =>
        line.id !== incoming.id &&
        line.status === "received" &&
        line.partId === incoming.partId &&
        normalizeSupplier(line.supplierName) === supplier,
    )
    .map((line) => line.id);
}

export type QuoteApplyValues = {
  unitCost: number;
  countryOfOrigin: string | null;
  /** Sheet supplier — becomes the part's manufacturer when set. */
  supplierName: string | null;
};

export type PartSnapshot = {
  unitCost: string | null; // numeric column round-trips as text
  countryOfOrigin: string | null;
  manufacturer: string | null;
};

export type PartFieldDiff = {
  /** field_changes.field (snake_case, matching "hts_code" precedent). */
  field: "unit_cost" | "country_of_origin" | "manufacturer";
  /** The parts column to patch. */
  column: "unitCost" | "countryOfOrigin" | "manufacturer";
  oldValue: string | null;
  newValue: string;
};

/**
 * The part writes an applied (or draft-finalizing) quote implies: unit cost
 * whenever it differs, COO and manufacturer only when the quote actually
 * carries them AND they differ. HTS is structurally absent — a supplier's
 * claimed code routes through the classification service, never through
 * quote application.
 */
export function diffQuoteAgainstPart(
  quote: QuoteApplyValues,
  part: PartSnapshot,
): PartFieldDiff[] {
  const diffs: PartFieldDiff[] = [];

  const newCost = quote.unitCost.toFixed(4);
  const oldCost = part.unitCost === null ? null : Number(part.unitCost).toFixed(4);
  if (oldCost !== newCost) {
    diffs.push({
      field: "unit_cost",
      column: "unitCost",
      oldValue: part.unitCost,
      newValue: newCost,
    });
  }

  const coo = quote.countryOfOrigin?.trim().toUpperCase() || null;
  if (coo !== null && coo !== part.countryOfOrigin) {
    diffs.push({
      field: "country_of_origin",
      column: "countryOfOrigin",
      oldValue: part.countryOfOrigin,
      newValue: coo,
    });
  }

  const manufacturer = quote.supplierName?.trim() || null;
  if (manufacturer !== null && manufacturer !== part.manufacturer) {
    diffs.push({
      field: "manufacturer",
      column: "manufacturer",
      oldValue: part.manufacturer,
      newValue: manufacturer,
    });
  }

  return diffs;
}
