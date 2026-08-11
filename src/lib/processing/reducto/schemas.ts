import type { DocumentTypeValue } from "@/lib/db/schema";
import type { SplitCategory } from "reductoai/resources/split";

// JSON Schemas for Reducto extraction. Field names mirror the *Extraction
// types in ../types.ts exactly (snake_case), so the mapper validates and
// coerces rather than renames. Descriptions carry the domain hints that
// drive extraction quality: date formats, rate conventions, CBP form
// specifics.

// entry_packet has no extract schema — packets are split into children, and
// the children extract under their own docType.
export type ExtractableDocType = Exclude<
  DocumentTypeValue,
  "other" | "entry_packet"
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
        "shipment",
        "purchase_order",
        "commercial_invoice",
        "packing_list",
        "quote_sheet",
        "refund_report",
        "entry_packet",
        "assist_sheet",
        "other",
      ],
      description:
        "The document's type. port_entry: a US CBP Form 7501 Entry Summary " +
        "or similar customs entry declaration, ALONE in this file. shipment: " +
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
        "commercial invoice. other: none of the above.",
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
    description: { type: ["string", "null"] },
    hts_code: {
      type: "string",
      description:
        "The 10-digit HTS classification the line is entered under, " +
        "formatted like 8714.91.3000. Not a Chapter 99 code.",
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
        "Net quantity in HTSUS units — 7501 column 31. On the form this " +
        "figure is followed by a unit-of-measure code (NO, KG, PCS, DOZ, " +
        "X). Extract only the number; the unit suffix is what marks it as " +
        "a quantity rather than a dollar value.",
    },
    unit_value: money(
      "Per-unit value, only if the document explicitly prints one. 7501s " +
        "usually do not — leave null rather than dividing or copying " +
        "another column.",
    ),
    entered_value: {
      type: "number",
      description:
        "The line's entered value in US dollars — 7501 column 32.A " +
        "('Entered Value'), usually a whole-dollar figure with no unit " +
        "suffix. A number followed by a unit code such as NO, KG, or PCS " +
        "is column 31's net quantity, not the entered value.",
    },
    charges: {
      type: "array",
      description:
        "Every duty and fee declared on this line: base duty, each Chapter " +
        "99 additional duty, MPF, HMF, AD/CVD.",
      items: ENTRY_CHARGE_SCHEMA,
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
      "Total entered value — 7501 block 35, the dollar total of all lines' " +
        "entered values. Not a quantity total.",
    ),
    total_duty: money("Total duty from the header (all duty, excluding MPF/HMF)"),
    mpf_amount: money("Total merchandise processing fee"),
    hmf_amount: money("Total harbor maintenance fee"),
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
    "501. Capture every charge on every line.",
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
