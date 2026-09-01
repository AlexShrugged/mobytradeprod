import type {
  ChargeTypeValue,
  DocumentTypeValue,
  PacketRoleValue,
} from "@/lib/db/schema";

// One declared duty/fee line on a 7501 declaration line. Amounts are
// dollars; rates are decimal fractions. A $0 amount is an exclusion claim.
export type EntryChargeExtraction = {
  charge_type: ChargeTypeValue;
  hts_code: string | null; // Ch99 code, or "499" (MPF) / "501" (HMF)
  rate: number | null;
  amount: number;
};

export type EntryLineItemExtraction = {
  line_number: number;
  sku: string | null;
  description: string | null;
  hts_code: string;
  // Special Program Indicator prefixed to the HTS number ("KR", "A", "AU")
  // — a claimed FTA/GSP preference. Optional so pre-widening writers (stub,
  // fixtures) stay valid; the Reducto mapper always emits it.
  spi?: string | null;
  country_of_origin: string | null;
  // Per-line supplier/manufacturer as shown on the entry — entries can span
  // vendors, and the (vendor, SKU) pair is what defines the expected origin.
  supplier_name: string | null;
  quantity: number | null;
  unit_value: number | null;
  entered_value: number;
  charges: EntryChargeExtraction[];
  // Compliance-critical facts below are document-only (no relational
  // column): they live in extracted_data for the entry analyst. Optional so
  // pre-widening writers (stub, fixtures) stay valid; the Reducto mapper
  // always emits them.
  /** AD/CVD case number declared for this line (e.g. A-570-121). */
  adcvd_case_number?: string | null;
  /** Manufacturer ID (MID) code for the line. */
  manufacturer_id?: string | null;
};

export type PortEntryExtraction = {
  entry_number: string;
  entry_date: string | null;
  port_of_entry: string | null;
  entry_type: string | null;
  importer_of_record: string | null;
  referenced_bols: string[];
  referenced_pos: string[];
  // Commercial invoice numbers referenced on the entry — the linker turns
  // these into direct entry_invoices links (creating a stub invoice row when
  // the CI hasn't been ingested yet, same pattern as referenced_pos).
  referenced_invoices: string[];
  total_entered_value: number | null;
  total_duty: number | null;
  mpf_amount: number | null;
  hmf_amount: number | null;
  line_items: EntryLineItemExtraction[];
  // Document-only compliance facts (see EntryLineItemExtraction note).
  /** Every distinct AD/CVD case number appearing anywhere on the entry. */
  adcvd_case_numbers?: string[];
  /** Bond type code/label (continuous, single transaction, none). */
  bond_type?: string | null;
  /** Surety company code. */
  surety_number?: string | null;
  /** Importer/seller related-party declaration, when the form shows one. */
  related_party?: boolean | null;
};

// A CBP 3461 / cargo release. Deliberately thin: the release identifies its
// entry and shipment(s) but is never authoritative for entry facts — the
// linker attaches it to EXISTING records only and creates nothing.
export type CargoReleaseExtraction = {
  entry_number: string;
  entry_date: string | null;
  referenced_bols: string[];
};

export type ShipmentExtraction = {
  bill_of_lading: string;
  container_number: string | null;
  carrier: string | null;
  vessel: string | null;
  // Evidenced by the document class itself (ocean BOL vs air waybill vs
  // road/rail docs); null when the document doesn't show it.
  mode: "ocean" | "air" | "truck" | "rail" | null;
  origin_port: string | null;
  destination_port: string | null;
  etd: string | null;
  eta: string | null;
  // BOL shipped-on-board notation — the laden date sail-conditioned tariff
  // measures gate on (ETD is the flagged fallback).
  shipped_on_board_date: string | null;
  referenced_pos: string[];
  // Document-only compliance facts (see EntryLineItemExtraction note). A
  // shipper who isn't the invoice supplier is a classic origin red flag.
  shipper_name?: string | null;
  consignee_name?: string | null;
};

// PO lines carry line_number + description because the linker persists them
// as purchase_order_lines — the grain quote→PO matching and per-SKU history
// run on.
export type PurchaseOrderLineExtraction = {
  line_number: number;
  sku: string;
  description: string | null;
  // Origin as logged on the PO line, when the document carries one.
  country_of_origin: string | null;
  quantity: number;
  unit_price: number;
};

export type PurchaseOrderExtraction = {
  po_number: string;
  supplier_name: string | null;
  order_date: string | null;
  currency: string;
  total_amount: number | null;
  line_items: PurchaseOrderLineExtraction[];
};

export type InvoiceLineItemExtraction = {
  line_number: number;
  sku: string | null;
  description: string | null;
  // Origin as logged on the invoice line, when the document carries one.
  country_of_origin: string | null;
  // HTS/HS code as printed — often 6/8-digit HS, not full 10-digit HTS, and
  // frequently absent. Feeds the CI-vs-entry HTS variance check.
  hts_code: string | null;
  quantity: number | null;
  unit_price: number | null;
  total_price: number;
  // Document-only compliance facts (see EntryLineItemExtraction note).
  /** AD/CVD case number printed on the line. */
  adcvd_case_number?: string | null;
  /** Manufacturer/producer named for the line when it differs from the
   *  invoice's seller — the producer-of-record signal AD/CVD rates hang on. */
  manufacturer_name?: string | null;
};

export type CommercialInvoiceExtraction = {
  invoice_number: string;
  po_number: string | null;
  supplier_name: string | null;
  invoice_date: string | null;
  currency: string;
  amount: number | null;
  incoterms: string | null;
  line_items: InvoiceLineItemExtraction[];
  // Document-only compliance facts (see EntryLineItemExtraction note).
  /** Payment terms as printed (e.g. "T/T 30 days", "L/C at sight"). */
  payment_terms?: string | null;
  /** Buyer/seller related-party statement, when the invoice carries one. */
  related_party?: boolean | null;
};

// One row of a broker "entry tariff code sheet" — ABI software output that
// maps each commercial-invoice line to the 7501 line it was filed under.
// The mapper collapses the printed stacked-Ch99 repetition (one printed row
// per tariff number) to one row per (7501 line, part number).
export type TariffCodeSheetRowExtraction = {
  /** The 7501 line number this part was filed under. */
  entry_line_number: number;
  /** The part number / SKU as printed. */
  part_number: string;
  po_number: string | null;
  description: string | null;
};

export type TariffCodeSheetExtraction = {
  entry_number: string;
  /** The broker's own file/reference number, when printed. */
  broker_ref: string | null;
  /** Commercial invoice number(s) the sheet covers. */
  referenced_invoices: string[];
  rows: TariffCodeSheetRowExtraction[];
};

export type PackingListExtraction = {
  bill_of_lading: string | null;
  cartons: number | null;
  gross_weight_kg: number | null;
  referenced_pos: string[];
};

// A supplier pricing sheet quoting unit costs per SKU. Everything on it is
// the SUPPLIER'S claim — COO and HTS here are display/estimate inputs only
// and never drive money or audit findings (a claimed HTS routes through the
// classification service).
export type QuoteSheetLineExtraction = {
  line_number: number;
  sku: string;
  description: string | null;
  unit_cost: number;
  currency: string | null;
  country_of_origin: string | null;
  hts_code: string | null;
  moq: number | null;
  lead_time_days: number | null;
  unit_of_measure: string | null;
};

export type QuoteSheetExtraction = {
  supplier_name: string | null;
  quote_date: string | null;
  currency: string;
  valid_until: string | null;
  notes: string | null;
  line_items: QuoteSheetLineExtraction[];
};

// An ACE ES-022-style refund report row. claim_status is the CBP decision;
// refund_status is the payout state — independent signals.
export type RefundClaimExtraction = {
  entry_summary_number: string;
  claim_type: string;
  claim_status: string | null;
  refund_status: string | null;
  refund_number: string | null;
  refund_class_amount: number;
  refund_interest_amount: number;
  entry_date: string | null;
  liquidation_date: string | null;
  refund_date: string | null;
};

export type RefundReportExtraction = {
  report_date: string | null;
  claims: RefundClaimExtraction[];
};

// One part of a split entry packet. The manifest (parts[]) is the parent
// document's extracted_data; each part becomes a child documents row.
export type PacketPartExtraction = {
  part_index: number; // 1-based position in the packet
  role: PacketRoleValue;
  doc_type: DocumentTypeValue; // via roleToDocType — the child's docType
  title: string | null; // the splitter's free-form section name
  pages: number[]; // 1-indexed pages of the parent PDF, sorted
  confidence: "high" | "low" | null;
};

export type EntryPacketExtraction = {
  parts: PacketPartExtraction[];
};

export type ExtractionResult =
  | { docType: "port_entry"; fields: PortEntryExtraction }
  | { docType: "cargo_release"; fields: CargoReleaseExtraction }
  | { docType: "shipment"; fields: ShipmentExtraction }
  | { docType: "purchase_order"; fields: PurchaseOrderExtraction }
  | { docType: "commercial_invoice"; fields: CommercialInvoiceExtraction }
  | { docType: "packing_list"; fields: PackingListExtraction }
  | { docType: "tariff_code_sheet"; fields: TariffCodeSheetExtraction }
  | { docType: "quote_sheet"; fields: QuoteSheetExtraction }
  | { docType: "refund_report"; fields: RefundReportExtraction }
  | { docType: "entry_packet"; fields: EntryPacketExtraction }
  | { docType: "other"; fields: Record<string, unknown> };

export type ProcessInput = {
  storageKey: string;
  fileName: string;
  mimeType: string;
  docTypeHint: DocumentTypeValue;
  /** 1 on first processing, 2+ on reprocess. The stub uses this to let
   *  retries succeed; a real extractor ignores it. */
  attempt: number;
  /** Set on packet children: which pages of the shared parent PDF are this
   *  document. Providers scope their parse to these pages. */
  pageRange?: number[] | null;
  /** Set on packet children. Marks "I am a packet part": the split role is
   *  authoritative, so providers skip classification (which has no assist
   *  category and would misroute assist sheets to commercial_invoice) and
   *  must never re-split. */
  packetRole?: PacketRoleValue | null;
};

// Complete provider payloads, retained verbatim in documents.raw_extraction
// so future AI features can mine fields that don't map into ExtractionResult.
// The three payloads share one lifecycle: written atomically on process,
// superseded together on reprocess.
export type RawExtraction = {
  provider: "reducto";
  /** Full parse output — every chunk/block, url-type results fetched inline. */
  parse: { jobId: string; duration?: number; usage: unknown; result: unknown };
  /** The small doc-type classification extract response. */
  classify: { jobId: string | null; usage: unknown; response: unknown } | null;
  /** The typed extract response, citations included; null for "other" docs. */
  extract: { jobId: string | null; usage: unknown; response: unknown } | null;
  /** The packet split response; only set on entry_packet parents. Optional so
   *  payloads persisted before packets existed stay valid. */
  split?: { jobId: string | null; usage: unknown; response: unknown } | null;
  retrievedAt: string;
};

export type ProcessOutput = {
  extraction: ExtractionResult;
  /** null when the stub processor ran. */
  raw: RawExtraction | null;
};

// message is user-facing (it lands in documents.error_message). When a parse
// succeeded before the failure, the already-paid-for payload rides along so
// the route can persist it for debugging and jobid:// reuse.
export class ProcessingError extends Error {
  constructor(
    message: string,
    readonly raw: RawExtraction | null = null,
    readonly parseJobId: string | null = null,
  ) {
    super(message);
    this.name = "ProcessingError";
  }
}

// The seam where extraction providers plug in: the Reducto implementation
// reads the file bytes by storageKey, calls the Reducto API, and maps the
// response into ExtractionResult. Nothing outside lib/processing changes.
export interface DocumentProcessor {
  process(input: ProcessInput): Promise<ProcessOutput>;
}
