// Block 43 of a broker's ABI 7501 printout — the "Other Fee Summary" — is
// where the fees CBP collected print: one row per collection code (499 MPF,
// 501 HMF, 012/013 AD/CVD deposits) with the per-entry minimum/maximum
// already applied, and a "Total Other Fees" figure the rows sum to. The
// line-level 499 charges above it are the broker's ad valorem workings
// ($15.19 on a $4,386 entry whose Block 43 prints $33.58), and the
// extractor filled the header mpf_amount from either at random (5 of ~30
// sub-minimum ASC entries took the line figure, one above-cap entry took
// the uncapped header working; 2026-09-17). Reading the block
// deterministically from the parse text — the line-sku.ts idiom — makes
// the header fields the collected figures every time, and hands the block
// to the entry analyst, which reads typed extractions only.
//
// Two renderings observed across all 158 ASC 7501s: a markdown table
// ("| 499 | 33.58 |" under a "| Other Fee Summary (for Block 43) |"
// heading) and bare lines ("499 36.51" under the heading). The block is
// self-checking: when "Total Other Fees" parses and the rows don't sum to
// it, nothing is applied — a dropped row would otherwise zero a fee.

import type { FeeSummaryRow, PortEntryExtraction } from "./types";

export type ParsedFeeSummary = {
  rows: FeeSummaryRow[];
  totalOtherFeesCents: number | null;
};

const HEADING = /other\s+fee\s+summary/i;
// The first structural marker after the block ends it.
const END_MARKERS = [
  /total\s+entered\s+value/i,
  /total\s+other\s+fees/i,
  /declaration\s+of\s+importer/i,
  /cbp\s+use\s+only/i,
];
const MONEY = "((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2})";
const ROW = new RegExp(`^\\s*(\\d{3})\\s+\\$?\\s*${MONEY}\\s*$`);
const TOTAL = new RegExp(
  `total\\s+other\\s+fees\\s*\\$?\\s*:?\\s*\\$?\\s*${MONEY}`,
  "i",
);
const WINDOW = 2000;

const toCents = (printed: string) =>
  Math.round(Number(printed.replace(/,/g, "")) * 100);

/** The Block 43 rows as printed, or null when the text has no parseable
 *  block (no heading, no code/amount rows, or rows that miss the printed
 *  total). */
export function parseFeeSummary(text: string): ParsedFeeSummary | null {
  const start = text.search(HEADING);
  if (start < 0) return null;
  const rest = text.slice(start, start + WINDOW);
  let end = rest.length;
  for (const marker of END_MARKERS) {
    const i = rest.search(marker);
    if (i > 0 && i < end) end = i;
  }
  const block = rest
    .slice(0, end)
    .replace(/<[^>]+>/g, " ")
    .replace(/\|/g, " ");
  const rows: FeeSummaryRow[] = [];
  const seen = new Set<string>();
  for (const line of block.split("\n")) {
    const m = ROW.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    rows.push({ code: m[1], amount: toCents(m[2]) / 100 });
  }
  if (rows.length === 0) return null;
  const total = TOTAL.exec(rest);
  const totalOtherFeesCents = total ? toCents(total[1]) : null;
  if (totalOtherFeesCents !== null) {
    const sum = rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    if (Math.abs(sum - totalOtherFeesCents) > 1) return null;
  }
  return { rows, totalOtherFeesCents };
}

/** The extraction with Block 43 as its fee facts: the header MPF/HMF become
 *  the collected 499/501 figures (0 when the block lists no such row — the
 *  fee was not assessed) and the block itself rides along as fee_summary.
 *  Untouched when the text carries no parseable block. */
export function applyFeeSummary(
  fields: PortEntryExtraction,
  parseText: string,
): PortEntryExtraction {
  const parsed = parseFeeSummary(parseText);
  if (!parsed) return fields;
  const amount = (code: string) =>
    parsed.rows.find((r) => r.code === code)?.amount ?? 0;
  return {
    ...fields,
    fee_summary: parsed.rows,
    mpf_amount: amount("499"),
    hmf_amount: amount("501"),
  };
}
