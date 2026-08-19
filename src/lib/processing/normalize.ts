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
