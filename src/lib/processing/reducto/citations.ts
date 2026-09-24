import type {
  CommercialInvoiceExtraction,
  ExtractionCitations,
  FieldCitation,
  FieldCitations,
  PortEntryExtraction,
  SourceBox,
} from "../types";

// Reads the provenance Reducto attaches to every extracted scalar: with
// citations enabled a leaf arrives as { value, citations: [{ content, bbox,
// ... }] }, the bbox in normalized page coordinates ([0, 1] of the page's
// width and height, origin top-left). Pure; the mapper decides WHICH leaves
// belong to which output row, this module only reads a leaf.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** The block text kept beside a box. A Table citation can carry the whole
 *  table's text; a few hundred characters is the row, which is what a
 *  reviewer wants to read. */
const PRINTED_MAX_CHARS = 400;

export type PageResolver = (bbox: {
  page: number;
  original_page?: number | null;
}) => number;

/** Reducto numbers a page-scoped parse from 1 in `page`. A packet child's
 *  citation must land on the parent PDF's page (the child shares the
 *  parent's bytes), and the provider has named that page two ways: payloads
 *  since 2026-09-11 put the source page in original_page, while earlier
 *  ones repeated the range-relative page there (every ASC/MotoRad child
 *  through 2026-09-09: original_page 1 on a page-5 invoice). An original
 *  that merely equals the relative page therefore says nothing and maps
 *  through the child's own page_range; one that differs is the source page.
 *  A standalone document's page is already the file's. */
export function pageResolver(
  pageRange: number[] | null | undefined,
): PageResolver {
  return (bbox) => {
    const original = isFiniteNumber(bbox.original_page)
      ? bbox.original_page
      : null;
    if (pageRange && pageRange.length > 0) {
      if (original !== null && original !== bbox.page) return original;
      return pageRange[bbox.page - 1] ?? original ?? bbox.page;
    }
    return original ?? bbox.page;
  };
}

/** One cited leaf's provenance: every box its citations name plus the
 *  printed text. null when the node is not a cited leaf, or the extractor
 *  inferred the value (no citations, or none with a usable box). */
export function leafCitation(
  node: unknown,
  pageOf: PageResolver,
): FieldCitation | null {
  if (!isRecord(node) || !("value" in node) || !Array.isArray(node.citations)) {
    return null;
  }
  const boxes: SourceBox[] = [];
  const printed: string[] = [];
  for (const citation of node.citations) {
    if (!isRecord(citation)) continue;
    const bbox = citation.bbox;
    if (
      isRecord(bbox) &&
      isFiniteNumber(bbox.left) &&
      isFiniteNumber(bbox.top) &&
      isFiniteNumber(bbox.width) &&
      isFiniteNumber(bbox.height) &&
      isFiniteNumber(bbox.page)
    ) {
      boxes.push({
        page: pageOf({
          page: bbox.page,
          original_page: isFiniteNumber(bbox.original_page)
            ? bbox.original_page
            : null,
        }),
        left: bbox.left,
        top: bbox.top,
        width: bbox.width,
        height: bbox.height,
      });
      if (typeof citation.content === "string" && citation.content.trim()) {
        printed.push(citation.content.trim());
      }
    }
  }
  if (boxes.length === 0) return null;
  const text = printed.join(" ");
  return {
    boxes,
    printed: text ? text.slice(0, PRINTED_MAX_CHARS) : null,
  };
}

/** Citations for the named scalar fields of one cited record — the fields
 *  the extractor cited and nothing else. */
export function recordCitations(
  record: unknown,
  fields: readonly string[],
  pageOf: PageResolver,
): FieldCitations {
  const out: FieldCitations = {};
  if (!isRecord(record)) return out;
  for (const field of fields) {
    const citation = leafCitation(record[field], pageOf);
    if (citation) out[field] = citation;
  }
  return out;
}

/** A citation only ever backs the value that persisted. The mapper and the
 *  post-extraction passes null out what they reject (an SPI that is not a
 *  code, a scrubbed SKU, a blanked mirrored quantity) and Block 43 replaces
 *  the header fees outright — so a field whose final value is null loses
 *  its citation, and the fees lose theirs when the fee summary governs.
 *  Never a guessed box: an uncited fact is honest, a wrong one is not. */
export function pruneCitations(
  fields: PortEntryExtraction | CommercialInvoiceExtraction,
  citations: ExtractionCitations,
): ExtractionCitations {
  const record = fields as unknown as Record<string, unknown>;
  const header = withoutNulls(citations.header, record);
  if ("fee_summary" in fields && fields.fee_summary) {
    delete header.mpf_amount;
    delete header.hmf_amount;
  }
  const lines = citations.lines.map((line, i) => {
    const mapped = fields.line_items[i] as unknown as
      | Record<string, unknown>
      | undefined;
    if (!mapped) return { fields: {}, charges: [] };
    const charges = Array.isArray(mapped.charges)
      ? (mapped.charges as Record<string, unknown>[])
      : [];
    return {
      fields: withoutNulls(line.fields, mapped),
      charges: line.charges.map((charge, j) =>
        charges[j] ? withoutNulls(charge, charges[j]) : {},
      ),
    };
  });
  return { header, lines };
}

function withoutNulls(
  citations: FieldCitations,
  mapped: Record<string, unknown>,
): FieldCitations {
  const out: FieldCitations = {};
  for (const [field, citation] of Object.entries(citations)) {
    if (mapped[field] === null || mapped[field] === undefined) continue;
    out[field] = citation;
  }
  return out;
}
