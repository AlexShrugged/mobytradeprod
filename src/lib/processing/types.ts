import type { ChargeTypeValue, DocumentTypeValue } from "@/lib/db/schema";

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
  country_of_origin: string | null;
  quantity: number | null;
  unit_value: number | null;
  entered_value: number;
  charges: EntryChargeExtraction[];
};

export type PortEntryExtraction = {
  entry_number: string;
  entry_date: string | null;
  port_of_entry: string | null;
  entry_type: string | null;
  importer_of_record: string | null;
  referenced_bols: string[];
  referenced_pos: string[];
  total_entered_value: number | null;
  total_duty: number | null;
  mpf_amount: number | null;
  hmf_amount: number | null;
  line_items: EntryLineItemExtraction[];
};

export type ShipmentExtraction = {
  bill_of_lading: string;
  container_number: string | null;
  carrier: string | null;
  vessel: string | null;
  origin_port: string | null;
  destination_port: string | null;
  etd: string | null;
  eta: string | null;
  // BOL shipped-on-board notation — the laden date sail-conditioned tariff
  // measures gate on (ETD is the flagged fallback).
  shipped_on_board_date: string | null;
  referenced_pos: string[];
};

// PO lines carry line_number + description because the linker persists them
// as purchase_order_lines — the grain quote→PO matching and per-SKU history
// run on.
export type PurchaseOrderLineExtraction = {
  line_number: number;
  sku: string;
  description: string | null;
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
  quantity: number | null;
  unit_price: number | null;
  total_price: number;
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

export type ExtractionResult =
  | { docType: "port_entry"; fields: PortEntryExtraction }
  | { docType: "shipment"; fields: ShipmentExtraction }
  | { docType: "purchase_order"; fields: PurchaseOrderExtraction }
  | { docType: "commercial_invoice"; fields: CommercialInvoiceExtraction }
  | { docType: "packing_list"; fields: PackingListExtraction }
  | { docType: "quote_sheet"; fields: QuoteSheetExtraction }
  | { docType: "refund_report"; fields: RefundReportExtraction }
  | { docType: "other"; fields: Record<string, unknown> };

export type ProcessInput = {
  storageKey: string;
  fileName: string;
  mimeType: string;
  docTypeHint: DocumentTypeValue;
  /** 1 on first processing, 2+ on reprocess. The stub uses this to let
   *  retries succeed; a real extractor ignores it. */
  attempt: number;
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
