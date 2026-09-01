import { normalizeBol } from "./normalize";
import type { PortEntryExtraction } from "./types";

// The 7501's part-number column is the extractor's weakest field: a broker
// ABI printout prints NO part number on its lines, so whatever comes back
// as `sku` is a neighbouring identifier mistaken for one. Three modes on
// prod (5 of 73 ASC 7501s, 2026-09-01):
//   - the manifest block's house bill under column 34 ("204 KG 1 PCS /
//     HB: EXD06810993766 1 PCS") — returned as "HB EXD…" or bare "EXD…";
//   - the line's PO reference ("PO#: 300-004183"), the very value the
//     extractor also reported in referenced_pos;
//   - the leading word of a Chapter 99 surcharge article text ("ARTS
//     ALU,STL,COP,DER ALU, DER" — the text the description hint forbids).
// A junk declared SKU is worse than none: on read it outranks the parts
// resolved from the tariff code sheet / commercial invoice (parts/
// line-parts.ts), and the invoice rules raise a "Not on invoice" variance
// for a part number that never existed. Deterministic scrub, no prompt
// change — extractor wording is stochastic run to run (reconcile.ts), and
// a value that is provably a document reference or article text needs no
// retry: the right answer is null. Pure; the processor hands in the parse
// text so a bare reference can be recognised by the label printed beside
// it on the page.

// Labels a broker prints before a shipment/commercial reference. Matched
// only with a separator (":" / "#" / whitespace) between label and value,
// so a part number that merely starts with these letters ("PO-1234",
// "BL2200") is untouched.
const REFERENCE_LABELS =
  "HB|HBL|H/B|H/BL|HAWB|MB|MBL|M/B|M/BL|MAWB|AWB|BL|B/L|BOL|PO|P\\.O\\.|INV|INVOICE|REF|CNTR|CONTAINER|SCAC";

const LABELED_VALUE = new RegExp(
  `^(?:${REFERENCE_LABELS})(?:\\s*[:#]\\s*|\\s+)(\\S.*)$`,
  "i",
);

// Lead words of the Chapter 99 article texts an ABI printout prints on a
// surcharge row ("ARTS ALU,STL,COP,DER…", "PRDTS OF CHINA"). A part number
// is an identifier; these are vocabulary.
const ARTICLE_TEXT_WORDS = new Set([
  "ART",
  "ARTS",
  "ARTICLE",
  "ARTICLES",
  "PRDT",
  "PRDTS",
  "PROD",
  "PRODS",
  "PRODUCT",
  "PRODUCTS",
  "GOODS",
  "DERIV",
  "DERIVATIVE",
  "DERIVATIVES",
  "MERCHANDISE",
]);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type JunkSkuReason =
  | "labeled_reference"
  | "document_reference"
  | "article_text"
  | "referenced_on_page";

/** Why a 7501 line's extracted sku is not a part number, or null when it
 *  may be one. `parseText` is the page text the extract ran over (Reducto
 *  parse chunks); null when unavailable, which only disables the on-page
 *  label check. */
export function junkSkuReason(
  sku: string,
  fields: Pick<
    PortEntryExtraction,
    | "entry_number"
    | "referenced_bols"
    | "referenced_pos"
    | "referenced_invoices"
    | "adcvd_case_numbers"
  >,
  parseText: string | null,
): JunkSkuReason | null {
  const trimmed = sku.trim();
  if (trimmed === "") return null;

  if (LABELED_VALUE.test(trimmed)) return "labeled_reference";

  if (ARTICLE_TEXT_WORDS.has(trimmed.toUpperCase())) return "article_text";

  const key = normalizeBol(trimmed);
  if (key !== "") {
    const references = [
      fields.entry_number,
      ...fields.referenced_bols,
      ...fields.referenced_pos,
      ...fields.referenced_invoices,
      ...(fields.adcvd_case_numbers ?? []),
    ];
    if (references.some((ref) => normalizeBol(ref) === key)) {
      return "document_reference";
    }
  }

  // A bare value the extractor lifted from beside a reference label: the
  // page prints "HB: EXD06810993766", the extract returned "EXD06810993766".
  // Any labeled occurrence condemns it — a real part number is never
  // printed after a bill-of-lading label anywhere on the form.
  if (parseText) {
    const onPage = new RegExp(
      `(?:^|[^A-Z0-9])(?:${REFERENCE_LABELS})(?:\\s*[:#]\\s*|\\s+)${escapeRegExp(trimmed)}(?![A-Z0-9])`,
      "i",
    );
    if (onPage.test(parseText)) return "referenced_on_page";
  }

  return null;
}

/** Blank every line sku that is provably not a part number. Pure — returns
 *  a new extraction; lines with a plausible sku (or none) pass through. */
export function scrubEntryLineSkus(
  fields: PortEntryExtraction,
  parseText: string | null,
): PortEntryExtraction {
  let changed = false;
  const line_items = fields.line_items.map((line) => {
    if (line.sku === null) return line;
    if (junkSkuReason(line.sku, fields, parseText) === null) return line;
    changed = true;
    return { ...line, sku: null };
  });
  return changed ? { ...fields, line_items } : fields;
}

/** The page text of a Reducto parse result (`parse.result.chunks[].content`
 *  joined); "" for any shape we don't recognise. Defensive over unknown —
 *  the provider payload is not under our control. */
export function parseResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const chunks = (result as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) return "";
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      const content = (chunk as { content?: unknown }).content;
      if (typeof content === "string") parts.push(content);
    }
  }
  return parts.join("\n");
}
