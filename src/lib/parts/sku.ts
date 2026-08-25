// SKU identity for matching. One normalized key decides when a catalog part
// and a document line (entry, PO, CI, quote) name the same SKU. Deliberately
// conservative, mirroring vendors/normalize.ts: trim + casefold ONLY — no
// punctuation or whitespace folding ("AB-C1" vs "ABC-1" may genuinely be two
// parts). A false merge silently ties a line to the wrong part's master
// data; a false split shows up as an Inactive SKU and is fixable by hand.
//
// Stored values keep their declared spelling (parts.sku, line sku columns) —
// normalization applies at MATCH time only, so parts_org_sku_uq stays on the
// raw sku and case-variant duplicate parts from before this existed can
// still be present. resolveSku keeps matching deterministic anyway: the
// exact spelling wins among case twins, ambiguity matches nothing.
//
// Dependency-free on purpose: imported by the pure import parsers and by
// db-facing modules alike. The SQL mirror lives in ./sku-sql.

/** Casefolded, trimmed SKU key; empty/whitespace collapses to null. The
 *  string overload is for callers whose input is already non-blank (zod
 *  trim().min(1), parse-phase cell cleaning). */
export function normalizeSku(sku: string): string;
export function normalizeSku(sku: string | null | undefined): string | null;
export function normalizeSku(sku: string | null | undefined): string | null {
  const key = sku?.trim().toUpperCase() ?? "";
  return key === "" ? null : key;
}

/** Normalized key → candidate parts. More than one candidate means
 *  case-variant duplicate rows (possible only for data predating normalized
 *  matching). */
export function buildSkuIndex<T extends { sku: string }>(
  parts: T[],
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const part of parts) {
    const key = normalizeSku(part.sku);
    if (key === null) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(part);
    else index.set(key, [part]);
  }
  return index;
}

/** The part a declared SKU resolves to: the sole normalized match, or the
 *  exact spelling among case twins. Null = absent, blank, or ambiguous. */
export function resolveSku<T extends { sku: string }>(
  index: Map<string, T[]>,
  rawSku: string | null | undefined,
): T | null {
  const key = normalizeSku(rawSku);
  if (key === null) return null;
  const candidates = index.get(key);
  if (!candidates) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((c) => c.sku === rawSku?.trim()) ?? null;
}
