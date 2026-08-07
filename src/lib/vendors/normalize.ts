// Vendor identity. One vendor row per distinct normalized name per org —
// this key decides when two documents name the same vendor. Deliberately
// conservative: trim + casefold ONLY. No suffix stripping ("Acme
// Components Co." vs "…Ltd." may genuinely be two firms), no punctuation
// folding — a false merge silently blends two vendors' sourcing facts, while
// a false split is visible and fixable (future merge tooling).
//
// Relative imports on purpose — reachable from the tsx seed script.

/** Casefolded, trimmed vendor key; empty/whitespace collapses to null. */
export function normalizeVendorName(
  name: string | null | undefined,
): string | null {
  const key = name?.trim().toLowerCase() ?? "";
  return key === "" ? null : key;
}
