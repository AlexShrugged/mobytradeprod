// Which catalog parts sit behind each 7501 line — resolved on READ, never
// stored (doctrine: derived data is never stored; only the tariff code
// sheet's rows persist, because a broker sheet is a declared fact).
//
// Three sources, in trust order:
//   declared — the 7501 line's own sku column (rare on real broker entries;
//              7501s have no part-number column).
//   sheet    — entry_line_parts rows from a broker tariff code sheet: the
//              broker's own statement of which invoice lines were filed
//              under which 7501 line.
//   invoice  — conservative inference from the entry's linked commercial
//              invoice lines. Brokers aggregate CI lines into 7501 lines BY
//              HTS CODE, so an invoice line attributes to an entry line only
//              when its printed HTS/HS code prefix-matches exactly ONE of
//              the entry's lines (or the entry has exactly one line). An
//              ambiguous match attributes nothing — the per-line pairing
//              heuristics this codebase retired must not sneak back in here.
//
// Pure and dependency-light: callers (queries) load the rows, this decides.

import { normalizeSku } from "./sku";

export type LinePartSource = "declared" | "sheet" | "invoice";

export type ResolvedLinePart = {
  /** The part number as printed by whichever source named it. */
  sku: string;
  /** The resolved catalog part, when the source row matched one. */
  partId: string | null;
  source: LinePartSource;
};

export type LinePartLineInput = {
  id: string;
  lineNumber: number;
  sku: string | null;
  partId: string | null;
  htsCodeDigits: string;
};

export type LinePartSheetRowInput = {
  lineNumber: number;
  sku: string;
  partId: string | null;
};

export type LinePartInvoiceLineInput = {
  sku: string | null;
  partId: string | null;
  htsCodeDigits: string | null;
};

/** line item id → the parts behind that line, declared/sheet/invoice rows
 *  first/next/last, deduped on the normalized SKU key (first source wins). */
export function resolveLineParts(
  lines: LinePartLineInput[],
  sheetRows: LinePartSheetRowInput[],
  invoiceLines: LinePartInvoiceLineInput[],
): Map<string, ResolvedLinePart[]> {
  const out = new Map<string, ResolvedLinePart[]>();
  const seen = new Map<string, Set<string>>();

  const add = (
    lineId: string,
    sku: string | null,
    partId: string | null,
    source: LinePartSource,
  ) => {
    const key = normalizeSku(sku);
    if (key === null) return;
    let dedupe = seen.get(lineId);
    if (!dedupe) {
      dedupe = new Set();
      seen.set(lineId, dedupe);
    }
    if (dedupe.has(key)) return;
    dedupe.add(key);
    let bucket = out.get(lineId);
    if (!bucket) {
      bucket = [];
      out.set(lineId, bucket);
    }
    bucket.push({ sku: (sku as string).trim(), partId, source });
  };

  const byLineNumber = new Map(lines.map((l) => [l.lineNumber, l]));

  for (const line of lines) add(line.id, line.sku, line.partId, "declared");

  for (const row of sheetRows) {
    const line = byLineNumber.get(row.lineNumber);
    if (line) add(line.id, row.sku, row.partId, "sheet");
  }

  // CI inference — only meaningful for lines no sheet covered, but the
  // ambiguity test always runs against ALL entry lines: a code that could
  // belong to two lines attributes to neither.
  const sheetCovered = new Set(
    sheetRows
      .map((r) => byLineNumber.get(r.lineNumber)?.id)
      .filter((id): id is string => id !== undefined),
  );
  for (const inv of invoiceLines) {
    if (normalizeSku(inv.sku) === null) continue;
    let target: LinePartLineInput | null = null;
    if (inv.htsCodeDigits && inv.htsCodeDigits.length >= 6) {
      const candidates = lines.filter((l) =>
        l.htsCodeDigits.startsWith(inv.htsCodeDigits as string),
      );
      if (candidates.length === 1) target = candidates[0];
    } else if (lines.length === 1) {
      target = lines[0];
    }
    if (target && !sheetCovered.has(target.id)) {
      add(target.id, inv.sku, inv.partId, "invoice");
    }
  }

  return out;
}
