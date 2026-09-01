import type { DocumentTypeValue } from "@/lib/db/schema";
import type { SplitCategory } from "reductoai/resources/split";

// JSON Schemas for Reducto extraction. Field names mirror the *Extraction
// types in ../types.ts exactly (snake_case), so the mapper validates and
// coerces rather than renames. Descriptions carry the domain hints that
// drive extraction quality: date formats, rate conventions, CBP form
// specifics.

// entry_packet has no extract schema — packets are split into children, and
// the children extract under their own docType. part_catalog never reaches
// the pipeline at all: catalog imports apply on the Parts page at upload.
export type ExtractableDocType = Exclude<
  DocumentTypeValue,
  "other" | "entry_packet" | "part_catalog"
>;

const date = (what: string) => ({
  type: ["string", "null"],
  description: `${what} in YYYY-MM-DD format.`,
});

const money = (what: string) => ({
  type: ["number", "null"],
  description: `${what} in US dollars.`,
});

export const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    doc_type: {
      type: "string",
      enum: [
        "port_entry",
        "cargo_release",
        "shipment",
        "purchase_order",
        "commercial_invoice",
        "packing_list",
        "quote_sheet",
        "refund_report",
        "entry_packet",
        "assist_sheet",
        "broker_invoice",
        "other",
      ],
      description:
        "The document's type. port_entry: a US CBP Form 7501 Entry Summary, " +
        "ALONE in this file — the form headed DEPARTMENT OF HOMELAND " +
        "SECURITY and titled ENTRY SUMMARY, with numbered declaration lines " +
        "carrying HTS codes, entered values, and duty/fee amounts. A " +
        "document is only port_entry when it IS that form; an entry number " +
        "alone does not make one. cargo_release: a US CBP Form 3461 " +
        "Entry/Immediate Delivery, cargo release, or broker release " +
        "notification — it shows an entry number and shipment references " +
        "but no per-line duty amounts; NOT an entry summary. shipment: " +
        "an ocean bill of lading, air waybill, or shipment confirmation. " +
        "purchase_order: a buyer's purchase order to a supplier. " +
        "commercial_invoice: a supplier's commercial invoice for goods. " +
        "packing_list: a packing list or packing slip for a shipment. " +
        "quote_sheet: a supplier pricing/quotation sheet quoting unit costs " +
        "per part number (not an invoice — it prices an offer, it does not " +
        "bill for shipped goods). refund_report: a CBP ACE ES-022-style " +
        "refund/liquidation report listing entry summary numbers with refund " +
        "amounts. entry_packet: a bundled multi-document broker packet — a " +
        "CBP 7501 entry summary PLUS supporting documents (commercial " +
        "invoice, packing list, bill of lading...) in one file. assist_sheet: " +
        "a worksheet of statutory additions to customs value (tooling, " +
        "molds, furnished materials) — columnar like an invoice but NOT a " +
        "commercial invoice. broker_invoice: a customs broker's or freight " +
        "forwarder's own bill to the importer for brokerage fees, duty/tax " +
        "advancement, and disbursements — invoice-shaped but NOT a " +
        "supplier's invoice for goods. other: none of the above.",
    },
  },
  required: ["doc_type"],
} as const;

export function classificationPrompt(
  fileName: string,
  hint: DocumentTypeValue,
): string {
  return (
    `Classify this trade/customs document. The file is named "${fileName}"` +
    (hint !== "other" ? ` and was provisionally classified as ${hint}` : "") +
    ". Judge by the document content, not the filename."
  );
}

const ENTRY_CHARGE_SCHEMA = {
  type: "object",
  properties: {
    charge_type: {
      type: "string",
      enum: [
        "base_duty",
        "additional_duty",
        "mpf",
        "hmf",
        "antidumping",
        "countervailing",
        "other_fee",
      ],
      description:
        "base_duty: the column-1 duty for the line's HTS code. " +
        "additional_duty: a Chapter 99 additional duty (Section 301/232, " +
        "IEEPA, reciprocal). mpf: merchandise processing fee (code 499). " +
        "hmf: harbor maintenance fee (code 501). antidumping/countervailing: " +
        "AD/CVD. other_fee: anything else.",
    },
    hts_code: {
      type: ["string", "null"],
      description:
        "The Chapter 99 HTS code the charge is declared under (e.g. " +
        "9903.88.01), or '499' for MPF / '501' for HMF. Null for base duty.",
    },
    rate: {
      type: ["number", "null"],
      description:
        "The duty rate as a decimal fraction: 0.25 for 25%. Null when the " +
        "document shows only an amount.",
    },
    amount: {
      type: "number",
      description:
        "The charge amount in US dollars. $0 indicates an exclusion claim.",
    },
  },
  required: ["charge_type", "amount"],
} as const;

const ENTRY_LINE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    line_number: {
      type: ["integer", "null"],
      description: "The 7501 line number (001, 002, ...).",
    },
    sku: {
      type: ["string", "null"],
      description: "The importer part number / SKU if shown on the line.",
    },
    description: {
      type: ["string", "null"],
      description:
        "The goods description from the line's commodity row — the text " +
        "printed with the 10-digit HTS classification (e.g. " +
        "'TUBE/PIPE,CU-ZINC,THREAD'). Never the article text of a Chapter " +
        "99 surcharge row ('ARTS ALU,STL,COP,DER...' describes a tariff " +
        "heading, not the goods).",
    },
    hts_code: {
      type: "string",
      description:
        "The 10-digit HTS classification the line is entered under, " +
        "formatted like 8714.91.3000. Not a Chapter 99 code, and never " +
        "including a letter prefix — a leading SPI code like KR or A " +
        "belongs in the spi field, not here.",
    },
    spi: {
      type: ["string", "null"],
      description:
        "The Special Program Indicator prefixed to the HTS number in " +
        "column 27 — a short letter code like KR, A, A+, AU, S+ printed " +
        "immediately before or above the tariff number, claiming " +
        "preferential (FTA/GSP) treatment. Null when the tariff number " +
        "carries no letter prefix.",
    },
    country_of_origin: {
      type: ["string", "null"],
      description: "ISO 3166-1 alpha-2 country of origin code, e.g. CN, TW.",
    },
    supplier_name: {
      type: ["string", "null"],
      description:
        "The foreign supplier / manufacturer named for this line, if the " +
        "entry shows one (e.g. next to the MID). Entries can span vendors.",
    },
    quantity: {
      type: ["number", "null"],
      description:
        "The line's net quantity in HTSUS units, printed on the commodity " +
        "row (the same row as the 10-digit HTS classification) and " +
        "followed by a unit-of-measure code (NO, KG, PCS, DOZ, X). " +
        "Extract only the number. Never copy the entered value — a figure " +
        "without a unit code is a dollar amount, not a quantity. Null when " +
        "the line prints no unit-suffixed figure.",
    },
    unit_value: money(
      "Per-unit value, only if the document explicitly prints one. 7501s " +
        "usually do not — leave null rather than dividing or copying " +
        "another column.",
    ),
    entered_value: {
      type: "number",
      description:
        "The line's entered value in US dollars — the column headed " +
        "'Entered Value'. Go by the heading, not the column number: broker " +
        "printouts number the grid differently. It is a dollar figure, " +
        "usually whole dollars, never followed by a unit code — a number " +
        "trailed by NO, KG, PCS, or similar is the net quantity, not the " +
        "entered value. Take the figure printed on this line's own " +
        "commodity row, in the same column where the Chapter 99 rows " +
        "above print 0. The unsuffixed figure printed beside the line's " +
        "FIRST tariff number (column 34, Gross Weight / Manifest Qty — " +
        "'9903.05.77  2297') is the gross weight in kilograms, never the " +
        "entered value. An 'Invoice Value USD' / 'Entered Value USD' " +
        "trailer printed after a group of lines is an invoice-block " +
        "subtotal, never a line's entered value. Cross-check: the line's " +
        "printed ad-valorem duty amounts equal rate times this value.",
    },
    charges: {
      type: "array",
      description:
        "Every duty and fee declared on this line: base duty, each Chapter " +
        "99 additional duty, MPF, HMF, AD/CVD. A line may stack SEVERAL " +
        "Chapter 99 tariff numbers above its classification code, and the " +
        "stack can continue onto a continuation sheet under the same line " +
        "number — every 99xx.xx.xx code in the stack is its own row here, " +
        "including FREE/$0 exclusion declarations (e.g. 9903.82.01, " +
        "9903.05.93). Never collapse the stack to one charge.",
      items: ENTRY_CHARGE_SCHEMA,
    },
    adcvd_case_number: {
      type: ["string", "null"],
      description:
        "The antidumping or countervailing duty case number declared for " +
        "this line, formatted like A-570-121 (AD) or C-570-122 (CVD). Null " +
        "when the line declares no AD/CVD case.",
    },
    manufacturer_id: {
      type: ["string", "null"],
      description:
        "The manufacturer identification code (MID) for this line — a " +
        "constructed code like CNSHEVOL123SHE. Extract the code itself, not " +
        "the manufacturer's name.",
    },
  },
  required: ["hts_code", "entered_value", "charges"],
} as const;

const PORT_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    entry_number: {
      type: "string",
      description:
        "The CBP entry number in XXX-XXXXXXX-X format (filer code, entry " +
        "number, check digit), e.g. 300-1234567-8.",
    },
    entry_date: date("Entry date"),
    port_of_entry: {
      type: ["string", "null"],
      description: "Port of entry name or code.",
    },
    entry_type: {
      type: ["string", "null"],
      description: "The two-digit entry type code, e.g. 01.",
    },
    importer_of_record: { type: ["string", "null"] },
    referenced_bols: {
      type: "array",
      items: { type: "string" },
      description:
        "Every bill of lading / AWB number referenced on the entry.",
    },
    referenced_pos: {
      type: "array",
      items: { type: "string" },
      description: "Every purchase order number referenced on the entry.",
    },
    referenced_invoices: {
      type: "array",
      items: { type: "string" },
      description:
        "Every commercial invoice number referenced on the entry or its " +
        "broker worksheets.",
    },
    total_entered_value: money(
      "The header block labeled 'Total Entered Value' — the dollar total " +
        "of all lines' entered values. Not a quantity or weight total.",
    ),
    total_duty: money("Total duty from the header (all duty, excluding MPF/HMF)"),
    mpf_amount: money("Total merchandise processing fee"),
    hmf_amount: money("Total harbor maintenance fee"),
    adcvd_case_numbers: {
      type: "array",
      items: { type: "string" },
      description:
        "Every distinct AD/CVD case number appearing anywhere on the entry " +
        "(header or lines), formatted like A-570-121 / C-570-122. Empty " +
        "when the entry declares none.",
    },
    bond_type: {
      type: ["string", "null"],
      description:
        "The bond type as shown (a code or label: continuous, single " +
        "transaction, none/government).",
    },
    surety_number: {
      type: ["string", "null"],
      description: "The surety company code, when the form shows one.",
    },
    related_party: {
      type: ["boolean", "null"],
      description:
        "Whether the importer declares a related-party transaction with " +
        "the seller. Null when the form doesn't answer the question.",
    },
    line_items: {
      type: "array",
      description:
        "Every declaration line on the entry summary — exactly one item per " +
        "7501 line number. Chapter 99 rows (9903.*) printed under a line " +
        "number are that line's additional-duty charges, NOT separate line " +
        "items.",
      items: ENTRY_LINE_ITEM_SCHEMA,
    },
  },
  required: ["entry_number", "line_items"],
} as const;

// Thin by design: the release only needs to identify its entry and
// shipment(s). No line items, no money — a cargo release is never
// authoritative for entry facts (see the cargo_release linker case).
const CARGO_RELEASE_SCHEMA = {
  type: "object",
  properties: {
    entry_number: {
      type: "string",
      description:
        "The CBP entry number in XXX-XXXXXXX-X format (filer code, entry " +
        "number, check digit), e.g. 300-1234567-8.",
    },
    entry_date: date("Entry date, if the release shows one"),
    referenced_bols: {
      type: "array",
      items: { type: "string" },
      description:
        "Every bill of lading / air waybill number on the release. Only " +
        "transport document numbers — not the entry number, in-bond number, " +
        "or broker reference numbers.",
    },
  },
  required: ["entry_number"],
} as const;

const SHIPMENT_SCHEMA = {
  type: "object",
  properties: {
    bill_of_lading: {
      type: "string",
      description: "The bill of lading or air waybill number.",
    },
    container_number: { type: ["string", "null"] },
    carrier: { type: ["string", "null"] },
    vessel: { type: ["string", "null"] },
    mode: {
      type: ["string", "null"],
      enum: ["ocean", "air", "truck", "rail", null],
      description:
        "The transport mode this document evidences: ocean for a bill of " +
        "lading, air for an air waybill, truck/rail for road or rail " +
        "documents. Null only when the document genuinely does not show it.",
    },
    origin_port: { type: ["string", "null"] },
    destination_port: { type: ["string", "null"] },
    etd: date("Estimated/actual departure date"),
    eta: date("Estimated/actual arrival date"),
    shipped_on_board_date: date(
      "The SHIPPED ON BOARD / LADEN ON BOARD notation date, if the document carries one",
    ),
    referenced_pos: {
      type: "array",
      items: { type: "string" },
      description: "Purchase order numbers referenced on the document.",
    },
    shipper_name: {
      type: ["string", "null"],
      description:
        "The shipper/consignor named on the document — the party tendering " +
        "the goods, which may differ from the commercial seller.",
    },
    consignee_name: {
      type: ["string", "null"],
      description: "The consignee named on the document.",
    },
  },
  required: ["bill_of_lading"],
} as const;

const PURCHASE_ORDER_SCHEMA = {
  type: "object",
  properties: {
    po_number: { type: "string", description: "The purchase order number." },
    supplier_name: { type: ["string", "null"] },
    order_date: date("Order date"),
    currency: {
      type: ["string", "null"],
      description: "ISO 4217 currency code, e.g. USD.",
    },
    total_amount: money("Order total"),
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_number: {
            type: ["integer", "null"],
            description: "The PO line number (1, 2, ...).",
          },
          sku: { type: "string", description: "Part number / SKU." },
          description: { type: ["string", "null"] },
          country_of_origin: {
            type: ["string", "null"],
            description:
              "ISO 3166-1 alpha-2 country of origin code logged on the " +
              "line, e.g. CN, VN.",
          },
          quantity: { type: "number" },
          unit_price: money("Per-unit price"),
        },
        required: ["sku"],
      },
      description: "Every goods line on the purchase order.",
    },
  },
  required: ["po_number"],
} as const;

const COMMERCIAL_INVOICE_SCHEMA = {
  type: "object",
  properties: {
    invoice_number: { type: "string" },
    po_number: {
      type: ["string", "null"],
      description: "The buyer purchase order number the invoice references.",
    },
    supplier_name: { type: ["string", "null"] },
    invoice_date: date("Invoice date"),
    currency: {
      type: ["string", "null"],
      description: "ISO 4217 currency code, e.g. USD.",
    },
    amount: money("Invoice total"),
    incoterms: {
      type: ["string", "null"],
      description: "Incoterms and named place, e.g. 'FOB Yantian'.",
    },
    payment_terms: {
      type: ["string", "null"],
      description:
        "Payment terms as printed, e.g. 'T/T 30 days' or 'L/C at sight'.",
    },
    related_party: {
      type: ["boolean", "null"],
      description:
        "Whether the invoice states the buyer and seller are related " +
        "parties. Null when it doesn't say.",
    },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_number: { type: ["integer", "null"] },
          sku: {
            type: ["string", "null"],
            description: "Part number / SKU.",
          },
          description: { type: ["string", "null"] },
          country_of_origin: {
            type: ["string", "null"],
            description:
              "ISO 3166-1 alpha-2 country of origin code logged on the " +
              "line, e.g. CN, VN.",
          },
          hts_code: {
            type: ["string", "null"],
            description:
              "The HTS/HS tariff code printed on the line, 6-10 digits as " +
              "shown, e.g. 8501.31.4000 or 850760. Null when the invoice " +
              "doesn't log one.",
          },
          quantity: { type: ["number", "null"] },
          unit_price: money("Per-unit price"),
          total_price: money("Extended line total"),
          adcvd_case_number: {
            type: ["string", "null"],
            description:
              "The AD/CVD case number printed for this line, formatted like " +
              "A-570-121 / C-570-122. Null when the invoice shows none.",
          },
          manufacturer_name: {
            type: ["string", "null"],
            description:
              "The manufacturer/producer named for this line when it " +
              "differs from the invoice's seller. Null when the invoice " +
              "names no separate producer.",
          },
        },
        required: ["total_price"],
      },
      description: "Every goods line on the invoice.",
    },
  },
  required: ["invoice_number"],
} as const;

const PACKING_LIST_SCHEMA = {
  type: "object",
  properties: {
    bill_of_lading: { type: ["string", "null"] },
    cartons: { type: ["integer", "null"], description: "Total carton count." },
    gross_weight_kg: {
      type: ["number", "null"],
      description: "Total gross weight in kilograms.",
    },
    referenced_pos: {
      type: "array",
      items: { type: "string" },
      description: "Purchase order numbers referenced on the document.",
    },
  },
} as const;

const QUOTE_SHEET_SCHEMA = {
  type: "object",
  properties: {
    supplier_name: {
      type: ["string", "null"],
      description: "The quoting supplier's company name.",
    },
    quote_date: date("The date printed on the quote"),
    currency: {
      type: ["string", "null"],
      description: "ISO 4217 currency code the sheet quotes in, e.g. USD.",
    },
    valid_until: date("The quote's validity/expiry date"),
    notes: {
      type: ["string", "null"],
      description:
        "Sheet-level terms or remarks (payment terms, tooling notes).",
    },
    line_items: {
      type: "array",
      description: "One row per quoted part number.",
      items: {
        type: "object",
        properties: {
          line_number: {
            type: ["integer", "null"],
            description: "The quote line number (1, 2, ...).",
          },
          sku: {
            type: "string",
            description: "The quoted part number / SKU as printed.",
          },
          description: { type: ["string", "null"] },
          unit_cost: money("The quoted per-unit cost"),
          currency: {
            type: ["string", "null"],
            description:
              "ISO 4217 currency code when a line quotes in a different " +
              "currency than the sheet; null otherwise.",
          },
          country_of_origin: {
            type: ["string", "null"],
            description:
              "ISO 3166-1 alpha-2 country of origin the supplier states, " +
              "e.g. CN, TW.",
          },
          hts_code: {
            type: ["string", "null"],
            description:
              "The HTS code the supplier suggests for the part, as printed. " +
              "This is the SUPPLIER'S claim, not an authoritative " +
              "classification.",
          },
          moq: {
            type: ["number", "null"],
            description: "Minimum order quantity.",
          },
          lead_time_days: {
            type: ["integer", "null"],
            description:
              "Production lead time in days (convert '4 weeks' to 28).",
          },
          unit_of_measure: {
            type: ["string", "null"],
            description: "Unit of measure the cost is quoted per, e.g. EA, SET.",
          },
        },
        required: ["sku", "unit_cost"],
      },
    },
  },
  required: ["line_items"],
} as const;

const REFUND_REPORT_SCHEMA = {
  type: "object",
  properties: {
    report_date: date("Report date"),
    claims: {
      type: "array",
      description: "One row per refund claim in the report.",
      items: {
        type: "object",
        properties: {
          entry_summary_number: {
            type: "string",
            description: "The entry summary number in XXX-XXXXXXX-X format.",
          },
          claim_type: {
            type: "string",
            description: "The claim type as printed, e.g. IEEPA REFUND.",
          },
          claim_status: {
            type: ["string", "null"],
            description: "The CBP claim decision status, e.g. CAPE ACCEPTED.",
          },
          refund_status: {
            type: ["string", "null"],
            description:
              "The payout status, e.g. TRANSMITTED TO TREASURY. Independent " +
              "of claim_status.",
          },
          refund_number: { type: ["string", "null"] },
          refund_class_amount: money("Refund principal amount"),
          refund_interest_amount: money("Refund interest amount"),
          entry_date: date("Entry date"),
          liquidation_date: date("Liquidation date"),
          refund_date: date("Refund date"),
        },
        required: ["entry_summary_number", "claim_type"],
      },
    },
  },
  required: ["claims"],
} as const;

export const EXTRACT_SCHEMAS: Record<ExtractableDocType, unknown> = {
  port_entry: PORT_ENTRY_SCHEMA,
  cargo_release: CARGO_RELEASE_SCHEMA,
  shipment: SHIPMENT_SCHEMA,
  purchase_order: PURCHASE_ORDER_SCHEMA,
  commercial_invoice: COMMERCIAL_INVOICE_SCHEMA,
  packing_list: PACKING_LIST_SCHEMA,
  quote_sheet: QUOTE_SHEET_SCHEMA,
  refund_report: REFUND_REPORT_SCHEMA,
};

export const SYSTEM_PROMPTS: Record<ExtractableDocType, string> = {
  port_entry:
    "This is a US CBP Form 7501 Entry Summary. Each declaration line carries " +
    "an HTS code, entered value, and one or more duty/fee charges: base duty " +
    "under the line's HTS code, Chapter 99 additional duties (Section " +
    "301/232, IEEPA, reciprocal), MPF under code 499, and HMF under code " +
    "501. Capture every charge on every line. A numbered line (001, 002, " +
    "...) often prints as a STACK of rows in the merchandise column: one " +
    "row per Chapter 99 surcharge first — each with its own article " +
    "description (e.g. 'ARTS ALU,STL,COP,DER') and rate/amount — then the " +
    "commodity row carrying the 10-digit classification, the goods " +
    "description, the net quantity with its unit code, and the entered " +
    "value. Read the line's own fields from the commodity row; the Chapter " +
    "99 rows above it are that line's additional-duty charges. The " +
    "unsuffixed figure printed beside the line's first tariff number is " +
    "column 34, the gross weight in kilograms — never the entered value " +
    "and never the net quantity; the entered value is the column-36 " +
    "dollar figure on the commodity row, where the Chapter 99 rows print " +
    "0 and a 'C <n>' row prints charges. A line's " +
    "stack may split across pages — a continuation sheet repeats the line " +
    "number and continues the same line, not a new one. Broker printouts " +
    "often group several numbered lines under one commercial invoice and " +
    "print an 'Invoice Value USD' / 'Entered Value USD' trailer after the " +
    "group: those are invoice-block subtotals, never a line's entered value " +
    "and never a reason to merge lines — a page with lines 001 and 002 " +
    "always yields two line_items, each with the entered value, quantity, " +
    "and charge stack from its own rows. Sanity-check every line: each " +
    "printed ad-valorem duty amount equals its rate times that line's own " +
    "entered value. Capture EVERY " +
    "Chapter 99 code in the stack as its own charge, including FREE/$0 " +
    "exclusion claims; never collapse the stack. A short letter code " +
    "prefixed to the 10-digit classification (KR, A, AU) is the Special " +
    "Program Indicator — report it in the line's spi field, never as part " +
    "of the HTS number. PO# references printed " +
    "between rows do not start a new line.",
  cargo_release:
    "This is a US CBP Form 3461 (Entry/Immediate Delivery) or a broker's " +
    "cargo release notification. Capture only the entry number, the entry " +
    "date if shown, and the transport document (BOL/AWB) numbers. Do not " +
    "report in-bond numbers or broker file references as bills of lading.",
  shipment:
    "This is an ocean bill of lading or air waybill. Capture the transport " +
    "document number, equipment, routing, and any purchase order references.",
  purchase_order:
    "This is a buyer's purchase order to a supplier. Capture the PO number, " +
    "supplier, totals, and each line's number, SKU, description, quantity, " +
    "and unit price.",
  commercial_invoice:
    "This is a supplier's commercial invoice. Capture the invoice number, " +
    "referenced purchase order, currency, total, incoterms, and every goods " +
    "line — including any HTS/HS tariff code printed on the line, verbatim.",
  packing_list:
    "This is a packing list for an export shipment. Capture the bill of " +
    "lading, carton count, gross weight, and purchase order references.",
  quote_sheet:
    "This is a supplier pricing sheet (quotation) quoting a unit cost per " +
    "part number. Rows may also carry MOQ, lead time, country of origin, " +
    "and an HTS code — capture all of them as printed. An HTS code on a " +
    "quote is the supplier's suggestion, not a customs ruling; capture it " +
    "verbatim without correcting it.",
  refund_report:
    "This is a CBP ACE ES-022-style refund report. Each row is one claim " +
    "against one entry summary number. claim_status is the CBP decision; " +
    "refund_status is the Treasury payout state — capture both as printed.",
};

// Section categories for splitting an entry packet. Names feed
// packet.normalizeRole, so keep them aligned with the packet role
// vocabulary. assist_sheet gets its own category — without one the splitter
// labels those columnar pages "invoice" and the assist amounts become a
// bogus commercial invoice.
export const SPLIT_CATEGORIES: SplitCategory[] = [
  {
    name: "Entry Summary 7501",
    description:
      "A US CBP Form 7501 Entry Summary or its continuation sheets: the " +
      "customs declaration with entry number, HTS lines, entered values, " +
      "and duty/fee amounts.",
  },
  {
    name: "Cargo Release",
    description:
      "A US CBP Form 3461 Entry/Immediate Delivery or broker cargo release " +
      "notification: shows an entry number and shipment references but no " +
      "per-line duty amounts. NOT the Entry Summary 7501.",
  },
  {
    name: "Commercial Invoice",
    description:
      "A supplier's commercial invoice billing for shipped goods: invoice " +
      "number, seller/buyer, goods lines with quantities and prices.",
  },
  {
    name: "Assist Sheet",
    description:
      "A worksheet of statutory additions to customs value — tooling, " +
      "molds, materials the importer furnished to the manufacturer. " +
      "Columnar like an invoice but NOT a commercial invoice.",
  },
  {
    name: "Broker Invoice",
    description:
      "The customs broker's or freight forwarder's own bill to the " +
      "importer — brokerage fees, duty advancement, disbursements, " +
      "handling charges. Invoice-shaped but NOT the supplier's commercial " +
      "invoice for the goods.",
  },
  {
    name: "Packing List",
    description:
      "A packing list or packing slip: cartons, weights, and shipment " +
      "contents without prices.",
  },
  {
    name: "Transport Document",
    description:
      "An ocean bill of lading, air waybill, arrival notice, or telex " +
      "release for the shipment.",
  },
  {
    name: "Certificate of Origin",
    description: "A certificate of origin attesting where goods were made.",
  },
  {
    name: "HTS Code List",
    description:
      "A tariff/HTS code worksheet listing classification codes per part.",
  },
  {
    name: "Other",
    description: "Any page that fits none of the other categories.",
  },
];

// Free-form guidance for the split call.
export const SPLIT_RULES =
  "This is a customs broker entry packet. Each CBP 7501 continuation sheet " +
  "belongs to the Entry Summary 7501 section. Keep each distinct document's " +
  "pages together in one section.";
