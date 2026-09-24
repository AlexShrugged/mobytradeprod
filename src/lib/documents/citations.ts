// Client-safe vocabulary for a persisted citation: the key a surface looks
// one up by, and where its page opens. The rows live in fact_citations
// (written by processing/linker.ts, read by db/queries/citations.ts).

export type CitedEntityType =
  | "entry"
  | "entry_line_item"
  | "entry_line_charge"
  | "invoice"
  | "invoice_line_item";

export type FactCitationRef = {
  id: string;
  /** 1-indexed page of the document's stored file. */
  page: number;
  documentId: string;
  /** The document class the fact was read from (documents.doc_type). */
  docType: string;
  /** The block text as printed, when the extractor kept it. */
  printed: string | null;
};

/** citationKey(...) → ref, for every cited field of a set of rows. */
export type FactCitationMap = Record<string, FactCitationRef>;

export function citationKey(
  entityType: CitedEntityType,
  entityId: string,
  field: string,
): string {
  return `${entityType}:${entityId}:${field}`;
}

/** The first of the named fields that carries a citation — a fallback
 *  chain, so a $0 exclusion claim whose amount is not printed still opens
 *  on the Chapter 99 code that is. */
export function findCitation(
  map: FactCitationMap,
  entityType: CitedEntityType,
  entityId: string | null | undefined,
  ...fields: string[]
): FactCitationRef | undefined {
  if (!entityId) return undefined;
  for (const field of fields) {
    const found = map[citationKey(entityType, entityId, field)];
    if (found) return found;
  }
  return undefined;
}

export function citationPageHref(citation: FactCitationRef): string {
  return `/api/citations/${citation.id}/page`;
}

/** What the document is called where the eye's tooltip names it. */
export function citationSourceLabel(docType: string): string {
  switch (docType) {
    case "port_entry":
      return "entry summary";
    case "commercial_invoice":
      return "invoice";
    default:
      return "document";
  }
}
