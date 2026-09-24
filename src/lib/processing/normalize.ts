// Normalization for the business numbers the linker matches records by.
// Pure: no IO, no db. The linker applies these at match time (SQL-side
// twins live inline there) so formatting drift across documents — an AWB
// printed "180-61914941" on the 7501 and "18061914941" on the waybill —
// lands on ONE record instead of minting duplicates.

/** Canonical form of a BOL/AWB number for matching: uppercase, digits and
 *  letters only. Display keeps the first-seen printed form. */
export function normalizeBol(bol: string): string {
  return bol.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Split a reference-number field that may pack several numbers into one
 *  string ("8119907E7,8119908E2" — extraction returns multi-PO invoices
 *  this way because the field is a scalar). Splits on commas, semicolons,
 *  and newlines; never on spaces or slashes (both appear inside real PO
 *  formats). Deduplicated, order preserved. */
export function splitReferenceNumbers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];
}

/** Width of purchase_orders.po_number. */
export const PO_NUMBER_MAX = 32;

// An order-number-shaped token: an optional short prefix, four or more
// digits, an optional suffix ("8119907E7", "8118476-1", "PO12345").
const PO_TOKEN = /^[A-Z]{0,3}\d{4,}[A-Z0-9-]*$/i;

/** A purchase-order reference that may pack several orders into ONE
 *  string. Beyond the comma/semicolon/newline split, a piece is read as a
 *  space- or slash-separated list when two or more of its tokens are
 *  order-number-shaped ("8121566 8122135 8122831 8123088 ATL",
 *  "8120346/8118676/8118476-1/8119753/8121086" — ASC's suppliers; four
 *  invoices failed on purchase_orders.po_number varchar(32) before this,
 *  2026-09-24). Real single formats keep their spaces and slashes
 *  ("PO 12345", "12345/A": one order-shaped token). Tokens that are not
 *  order-shaped ("ATL") are a suffix, not an order. Every result is capped
 *  to the column width so a reference can never fail the document. */
export function splitPoReferences(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const piece of splitReferenceNumbers(raw)) {
    const tokens = piece.split(/[\s/]+/).filter((t) => t !== "");
    const orders = tokens.filter((t) => PO_TOKEN.test(t));
    for (const p of orders.length >= 2 ? orders : [piece]) {
      out.push(p.slice(0, PO_NUMBER_MAX));
    }
  }
  return [...new Set(out)];
}
