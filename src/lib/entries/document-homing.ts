// Homes each of an entry page's documents under exactly ONE Linked-records
// group. Pure: no IO, no db — getEntryDetail feeds it the document_links
// rows it fetched for the entry and its linked sub-records.
//
// The rules are deliberately conservative: a document homes under a record
// only when its CLASS matches that record (a BOL under its shipment, a CI
// under its invoice, entry paperwork under the entry) or when it created
// the entry. Everything else — a sibling entry's 7501 that shares this
// entry's PO, a release whose entry isn't this one, the long tail of
// paperwork nothing claims — goes to Miscellaneous. Force-bucketing those
// under whichever record they happened to reference is how a 7501 once
// rendered as a purchase order's document.

export type DocumentHomeLink = {
  entityType: string;
  entityId: string;
  created: boolean;
};

/** Sentinel home for documents no group claims. */
export const MISC_HOME = "misc";

// The Linked-records group (by document_links entity type) each document
// class belongs to. Absent docTypes (other, quote_sheet, entry_packet…)
// belong to no group and can only land in Miscellaneous.
const SECTION_BY_DOC_TYPE: Record<
  string,
  "entry" | "shipment" | "invoice" | "purchase_order"
> = {
  port_entry: "entry",
  cargo_release: "entry",
  refund_report: "entry",
  shipment: "shipment",
  packing_list: "shipment",
  commercial_invoice: "invoice",
  purchase_order: "purchase_order",
};

/** The one group key ("entityType:entityId", or MISC_HOME) a document
 *  renders under on the page for `entryId`. */
export function homeForDocument(
  docType: string,
  links: DocumentHomeLink[],
  entryId: string,
): string {
  const section = SECTION_BY_DOC_TYPE[docType] ?? null;
  const entryLink = links.find(
    (l) => l.entityType === "entry" && l.entityId === entryId,
  );
  // This entry's own paperwork: it created the entry, or it is entry-class
  // paperwork (7501, cargo release, refund report) linked to it — creation
  // isn't required, so the real 7501 still homes here when a weaker
  // document won the race to create the entry.
  if (entryLink && (entryLink.created || section === "entry")) {
    return `entry:${entryId}`;
  }
  if (section !== null && section !== "entry") {
    // The sub-record of its own class it created (a BOL's home is its
    // shipment, a CI's its invoice), else one of its class it references
    // (a packing list under its shipment).
    const own = links.filter((l) => l.entityType === section);
    const home = own.find((l) => l.created) ?? own[0];
    if (home) return `${home.entityType}:${home.entityId}`;
  }
  return MISC_HOME;
}
