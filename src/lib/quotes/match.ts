// The pure decision logic behind quotes/service.ts — quote↔PO matching,
// winner selection, auto-supersede selection, and the (part, vendor) source
// diff an application implies. No DB, no IO, test-pinned: the service only
// executes what these functions decide, so the semantics that matter (price
// tolerance, vendor gating, "approved lines are never auto-superseded",
// "HTS never flows from a quote") are all provable here without a database.
//
// Vendors compare by RESOLVED id (vendors/service.ts find-or-creates from
// declared names), so matching survives a vendor rename and never re-parses
// name strings.
//
// Relative imports on purpose — reachable from the tsx seed script.

export type PoLineMatchInput = {
  /** purchase_order_lines.part_id — null never matches. */
  partId: string | null;
  /** Numeric unit price; null never matches (no price to agree with). */
  unitPrice: number | null;
  // --- PO header context ---
  orderDate: string | null; // ISO date
  currency: string;
  /** Resolved header vendor; null when the PO named no supplier. */
  vendorId: string | null;
};

export type QuoteLineMatchInput = {
  partId: string;
  unitCost: number;
  currency: string;
  // --- sheet context ---
  quoteDate: string | null; // ISO date
  /** Resolved sheet vendor; null when the sheet named no supplier. */
  vendorId: string | null;
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
 *   - vendors gate only when BOTH sides resolved one — a PO without a
 *     supplier does not block.
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

  if (
    po.vendorId !== null &&
    quote.vendorId !== null &&
    po.vendorId !== quote.vendorId
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
  /** The candidate line's SHEET vendor (resolved). */
  vendorId: string | null;
};

/**
 * Which existing lines a newly ingested one pushes aside: RECEIVED lines
 * for the same (part, vendor). Approved/applied/rejected lines are human
 * decisions and are NEVER auto-superseded — the UI flags "newer quote
 * exists" instead. An unnamed sheet (null vendor) only supersedes other
 * unnamed sheets — it cannot displace a named vendor's standing quote.
 */
export function selectSupersededLineIds(
  incoming: { id: string; partId: string; vendorId: string | null },
  existing: SupersedeCandidate[],
): string[] {
  return existing
    .filter(
      (line) =>
        line.id !== incoming.id &&
        line.status === "received" &&
        line.partId === incoming.partId &&
        line.vendorId === incoming.vendorId,
    )
    .map((line) => line.id);
}

export type QuoteApplyValues = {
  unitCost: number;
  countryOfOrigin: string | null;
};

/** The (part, vendor) source row's current facts; null = no source yet. */
export type SourceSnapshot = {
  unitCost: string | null; // numeric column round-trips as text
  countryOfOrigin: string | null;
} | null;

export type SourceFieldDiff = {
  /** field_changes.field (snake_case, matching "hts_code" precedent). */
  field: "unit_cost" | "country_of_origin";
  /** The part_sources column to patch. */
  column: "unitCost" | "countryOfOrigin";
  oldValue: string | null;
  newValue: string;
};

/**
 * The (part, vendor) source writes an applied (or draft-finalizing) quote
 * implies: unit cost whenever it differs, COO only when the quote actually
 * carries one AND it differs — a quote can never null out a standing COO.
 * A null source (the vendor is new for this part) seeds a full row. HTS is
 * structurally absent — a supplier's claimed code routes through the
 * classification service, never through quote application.
 */
export function diffQuoteAgainstSource(
  quote: QuoteApplyValues,
  source: SourceSnapshot,
): SourceFieldDiff[] {
  const diffs: SourceFieldDiff[] = [];

  const newCost = quote.unitCost.toFixed(4);
  const oldCost =
    source?.unitCost == null ? null : Number(source.unitCost).toFixed(4);
  if (oldCost !== newCost) {
    diffs.push({
      field: "unit_cost",
      column: "unitCost",
      oldValue: source?.unitCost ?? null,
      newValue: newCost,
    });
  }

  const coo = quote.countryOfOrigin?.trim().toUpperCase() || null;
  if (coo !== null && coo !== (source?.countryOfOrigin ?? null)) {
    diffs.push({
      field: "country_of_origin",
      column: "countryOfOrigin",
      oldValue: source?.countryOfOrigin ?? null,
      newValue: coo,
    });
  }

  return diffs;
}
