import { chargeType, documentType } from "@/lib/db/schema";
import type { ChargeTypeValue, DocumentTypeValue } from "@/lib/db/schema";
import type {
  CargoReleaseExtraction,
  CommercialInvoiceExtraction,
  EntryChargeExtraction,
  EntryLineItemExtraction,
  ExtractionResult,
  PackingListExtraction,
  PortEntryExtraction,
  PurchaseOrderExtraction,
  QuoteSheetExtraction,
  RefundClaimExtraction,
  RefundReportExtraction,
  ShipmentExtraction,
} from "../types";
import { ProcessingError } from "../types";
import type { ExtractableDocType } from "./schemas";

// Pure mapping from Reducto extract responses to ExtractionResult. This is
// the safety boundary in front of the linker: the linker inserts these
// values straight into pg enums and calls .toFixed() on the numbers inside
// one transaction, so everything here must come out enum-valid, number-or-
// null, and array-not-undefined.

const CHARGE_TYPES = new Set<string>(chargeType.enumValues);
const DOC_TYPES = new Set<string>(documentType.enumValues);

/** Reducto's extract result is a list of chunk objects; with citations
 *  enabled chunking is off and it has one element, but merge defensively. */
export function mergeResultChunks(result: unknown): Record<string, unknown> {
  const items = Array.isArray(result) ? result : [result];
  const merged: Record<string, unknown> = {};
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      Object.assign(merged, item);
    }
  }
  return merged;
}

/** With citations enabled, every scalar arrives as { value, citations }.
 *  Recursively unwrap to plain values; a no-op on already-plain data. */
export function unwrapCitations(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(unwrapCitations);
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if ("value" in record && Array.isArray(record.citations)) {
      return unwrapCitations(record.value);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = unwrapCitations(value);
    }
    return out;
  }
  return node;
}

function toStr(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/** true/false (or their common string spellings) → boolean; else null. */
function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "no" || s === "n") return false;
  return null;
}

/** "$1,575.00", "25%", 1575 → number; anything unparseable → null. */
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const isPercent = v.includes("%");
  const cleaned = v.replace(/[$,\s%]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return isPercent ? n / 100 : n;
}

function toInt(v: unknown): number | null {
  const n = toNum(v);
  return n === null ? null : Math.trunc(n);
}

/** ISO country codes compare exact-match downstream (measure gating,
 *  COO-vs-catalog audit) — normalize case here so "cn" never slips through. */
function toCountry(v: unknown): string | null {
  return toStr(v)?.toUpperCase() ?? null;
}

/** Normalize to YYYY-MM-DD; accepts ISO datetimes and MM/DD/YYYY. */
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function toDate(v: unknown): string | null {
  const s = toStr(v);
  if (!s) return null;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  // "June 16, 2026" / "16 JUN 2026" — BOL on-board notations use both.
  const mdy = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdy) {
    const m = MONTHS[mdy[1].slice(0, 3).toLowerCase()];
    if (m) return `${mdy[3]}-${m}-${mdy[2].padStart(2, "0")}`;
  }
  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (dmy) {
    const m = MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (m) return `${dmy[3]}-${m}-${dmy[1].padStart(2, "0")}`;
  }
  return s;
}

function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(toStr).filter((s): s is string => s !== null);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asRecordArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>);
}

function required(value: string | null, label: string): string {
  if (value === null) {
    throw new ProcessingError(
      `Extraction did not find a ${label} in the document.`,
    );
  }
  return value;
}

export function classifyFromResponse(
  result: unknown,
  hint: DocumentTypeValue,
): DocumentTypeValue {
  const data = unwrapCitations(mergeResultChunks(result)) as Record<
    string,
    unknown
  >;
  const value = toStr(data.doc_type);
  // assist_sheet and broker_invoice are classification-only labels (they
  // protect standalone uploads from the commercial_invoice pipeline); they
  // have no docType of their own.
  if (value === "assist_sheet" || value === "broker_invoice") return "other";
  if (value && DOC_TYPES.has(value)) return value as DocumentTypeValue;
  return hint;
}

function mapCharge(raw: Record<string, unknown>): EntryChargeExtraction {
  const declaredType = toStr(raw.charge_type);
  return {
    // Clamp to the pg enum — an invalid value would abort the whole linker
    // transaction on insert into entry_line_charges.
    charge_type:
      declaredType && CHARGE_TYPES.has(declaredType)
        ? (declaredType as ChargeTypeValue)
        : "other_fee",
    hts_code: toStr(raw.hts_code),
    rate: toNum(raw.rate),
    amount: toNum(raw.amount) ?? 0,
  };
}

function isCh99(hts: string): boolean {
  return hts.replace(/\D/g, "").startsWith("99");
}

function mapLineItems(raw: unknown): EntryLineItemExtraction[] {
  // Lines with no HTS code cannot be declared lines; drop rather than fail
  // the whole document.
  const rows = asRecordArray(raw)
    .filter((line) => toStr(line.hts_code) !== null)
    .map((line, index) => ({
      line_number: toInt(line.line_number) ?? index + 1,
      sku: toStr(line.sku),
      description: toStr(line.description),
      hts_code: toStr(line.hts_code) as string,
      country_of_origin: toCountry(line.country_of_origin),
      supplier_name: toStr(line.supplier_name),
      quantity: toNum(line.quantity),
      unit_value: toNum(line.unit_value),
      entered_value: toNum(line.entered_value) ?? 0,
      charges: asRecordArray(line.charges).map(mapCharge),
      adcvd_case_number: toStr(line.adcvd_case_number),
      manufacturer_id: toStr(line.manufacturer_id),
    }));

  // A 7501 prints a line's Chapter 99 supplemental codes (Section 301/232,
  // IEEPA, exclusions) as extra rows under the same line number, and
  // extraction sometimes returns those rows as separate line_items despite
  // the schema asking otherwise. One declared line per number: the non-Ch99
  // row keeps the goods facts, and each supplemental row folds in as
  // charges — a charge without its own hts_code inherits the row's Ch99
  // code, and a row with no charges at all becomes a $0 charge under its
  // code so the claim it represents survives (a $0 amount is an exclusion
  // claim; the auditor flags it if duty was expected). The supplemental
  // row's entered_value is the duty basis — the base line's value printed
  // again — never additive.
  const byNumber = new Map<number, EntryLineItemExtraction[]>();
  for (const row of rows) {
    const group = byNumber.get(row.line_number);
    if (group) group.push(row);
    else byNumber.set(row.line_number, [row]);
  }
  return [...byNumber.values()].map((group) => {
    const base = group.find((row) => !isCh99(row.hts_code)) ?? group[0];
    if (group.length === 1) return base;
    return {
      ...base,
      charges: group.flatMap((row) => {
        if (row === base) return row.charges;
        if (row.charges.length === 0) {
          return [
            {
              charge_type: "additional_duty" as const,
              hts_code: row.hts_code,
              rate: null,
              amount: 0,
            },
          ];
        }
        return row.charges.map((charge) => ({
          ...charge,
          hts_code: charge.hts_code ?? row.hts_code,
        }));
      }),
    };
  });
}

function mapPortEntry(data: Record<string, unknown>): PortEntryExtraction {
  return {
    entry_number: required(toStr(data.entry_number), "CBP entry number"),
    entry_date: toDate(data.entry_date),
    port_of_entry: toStr(data.port_of_entry),
    entry_type: toStr(data.entry_type),
    importer_of_record: toStr(data.importer_of_record),
    referenced_bols: toStrArray(data.referenced_bols),
    referenced_pos: toStrArray(data.referenced_pos),
    referenced_invoices: toStrArray(data.referenced_invoices),
    total_entered_value: toNum(data.total_entered_value),
    total_duty: toNum(data.total_duty),
    mpf_amount: toNum(data.mpf_amount),
    hmf_amount: toNum(data.hmf_amount),
    line_items: mapLineItems(data.line_items),
    adcvd_case_numbers: toStrArray(data.adcvd_case_numbers),
    bond_type: toStr(data.bond_type),
    surety_number: toStr(data.surety_number),
    related_party: toBool(data.related_party),
  };
}

function mapCargoRelease(
  data: Record<string, unknown>,
): CargoReleaseExtraction {
  return {
    entry_number: required(toStr(data.entry_number), "CBP entry number"),
    entry_date: toDate(data.entry_date),
    referenced_bols: toStrArray(data.referenced_bols),
  };
}

const SHIPMENT_MODES = new Set(["ocean", "air", "truck", "rail"]);

function toMode(v: unknown): ShipmentExtraction["mode"] {
  const s = toStr(v);
  return s !== null && SHIPMENT_MODES.has(s)
    ? (s as Exclude<ShipmentExtraction["mode"], null>)
    : null;
}

function mapShipment(data: Record<string, unknown>): ShipmentExtraction {
  return {
    bill_of_lading: required(
      toStr(data.bill_of_lading),
      "bill of lading number",
    ),
    container_number: toStr(data.container_number),
    carrier: toStr(data.carrier),
    vessel: toStr(data.vessel),
    mode: toMode(data.mode),
    origin_port: toStr(data.origin_port),
    destination_port: toStr(data.destination_port),
    etd: toDate(data.etd),
    eta: toDate(data.eta),
    shipped_on_board_date: toDate(data.shipped_on_board_date),
    referenced_pos: toStrArray(data.referenced_pos),
    shipper_name: toStr(data.shipper_name),
    consignee_name: toStr(data.consignee_name),
  };
}

function mapPurchaseOrder(
  data: Record<string, unknown>,
): PurchaseOrderExtraction {
  return {
    po_number: required(toStr(data.po_number), "purchase order number"),
    supplier_name: toStr(data.supplier_name),
    order_date: toDate(data.order_date),
    currency: toStr(data.currency) ?? "USD",
    total_amount: toNum(data.total_amount),
    // Map before filtering so the position fallback for line_number
    // reflects the document, not the surviving subset.
    line_items: asRecordArray(data.line_items)
      .map((line, i) => ({
        line_number: toInt(line.line_number) ?? i + 1,
        sku: toStr(line.sku),
        description: toStr(line.description),
        country_of_origin: toCountry(line.country_of_origin),
        quantity: toNum(line.quantity) ?? 0,
        unit_price: toNum(line.unit_price) ?? 0,
      }))
      .filter(
        (line): line is typeof line & { sku: string } => line.sku !== null,
      ),
  };
}

function mapCommercialInvoice(
  data: Record<string, unknown>,
): CommercialInvoiceExtraction {
  return {
    invoice_number: required(toStr(data.invoice_number), "invoice number"),
    po_number: toStr(data.po_number),
    supplier_name: toStr(data.supplier_name),
    invoice_date: toDate(data.invoice_date),
    currency: toStr(data.currency) ?? "USD",
    amount: toNum(data.amount),
    incoterms: toStr(data.incoterms),
    payment_terms: toStr(data.payment_terms),
    related_party: toBool(data.related_party),
    // Map before filtering so the position fallback for line_number
    // reflects the document, not the surviving subset.
    line_items: asRecordArray(data.line_items)
      .map((line, i) => ({
        line_number: toInt(line.line_number) ?? i + 1,
        sku: toStr(line.sku),
        description: toStr(line.description),
        country_of_origin: toCountry(line.country_of_origin),
        hts_code: toStr(line.hts_code),
        quantity: toNum(line.quantity),
        unit_price: toNum(line.unit_price),
        total_price: toNum(line.total_price),
        adcvd_case_number: toStr(line.adcvd_case_number),
        manufacturer_name: toStr(line.manufacturer_name),
      }))
      .filter(
        (line): line is typeof line & { total_price: number } =>
          line.total_price !== null,
      ),
  };
}

function mapPackingList(data: Record<string, unknown>): PackingListExtraction {
  return {
    bill_of_lading: toStr(data.bill_of_lading),
    cartons: toInt(data.cartons),
    gross_weight_kg: toNum(data.gross_weight_kg),
    referenced_pos: toStrArray(data.referenced_pos),
  };
}

function mapQuoteSheet(data: Record<string, unknown>): QuoteSheetExtraction {
  // A quote line without a SKU or a unit cost quotes nothing ingestible —
  // drop it rather than fail the whole document. Map before filtering so
  // the position fallback for line_number reflects the document.
  const lineItems = asRecordArray(data.line_items)
    .map((line, i) => ({
      line_number: toInt(line.line_number) ?? i + 1,
      sku: toStr(line.sku),
      description: toStr(line.description),
      unit_cost: toNum(line.unit_cost),
      currency: toStr(line.currency),
      country_of_origin: toCountry(line.country_of_origin),
      hts_code: toStr(line.hts_code),
      moq: toNum(line.moq),
      lead_time_days: toInt(line.lead_time_days),
      unit_of_measure: toStr(line.unit_of_measure),
    }))
    .filter(
      (line): line is typeof line & { sku: string; unit_cost: number } =>
        line.sku !== null && line.unit_cost !== null,
    );
  // Like a claimless refund report: a quote sheet with no usable lines has
  // nothing to ingest — fail loudly instead of writing an empty sheet.
  if (lineItems.length === 0) {
    throw new ProcessingError(
      "Extraction did not find any quoted line items in the quote sheet.",
    );
  }
  return {
    supplier_name: toStr(data.supplier_name),
    quote_date: toDate(data.quote_date),
    currency: toStr(data.currency) ?? "USD",
    valid_until: toDate(data.valid_until),
    notes: toStr(data.notes),
    line_items: lineItems,
  };
}

function mapRefundClaim(raw: Record<string, unknown>): RefundClaimExtraction {
  return {
    entry_summary_number: toStr(raw.entry_summary_number) as string,
    claim_type: toStr(raw.claim_type) ?? "UNKNOWN",
    claim_status: toStr(raw.claim_status),
    refund_status: toStr(raw.refund_status),
    refund_number: toStr(raw.refund_number),
    refund_class_amount: toNum(raw.refund_class_amount) ?? 0,
    refund_interest_amount: toNum(raw.refund_interest_amount) ?? 0,
    entry_date: toDate(raw.entry_date),
    liquidation_date: toDate(raw.liquidation_date),
    refund_date: toDate(raw.refund_date),
  };
}

function mapRefundReport(
  data: Record<string, unknown>,
): RefundReportExtraction {
  const claims = asRecordArray(data.claims)
    .filter((claim) => toStr(claim.entry_summary_number) !== null)
    .map(mapRefundClaim);
  if (claims.length === 0) {
    throw new ProcessingError(
      "Extraction did not find any refund claims in the report.",
    );
  }
  return { report_date: toDate(data.report_date), claims };
}

export function mapExtractToResult(
  docType: ExtractableDocType,
  result: unknown,
): ExtractionResult {
  const data = asRecord(unwrapCitations(mergeResultChunks(result)));
  switch (docType) {
    case "port_entry":
      return { docType, fields: mapPortEntry(data) };
    case "cargo_release":
      return { docType, fields: mapCargoRelease(data) };
    case "shipment":
      return { docType, fields: mapShipment(data) };
    case "purchase_order":
      return { docType, fields: mapPurchaseOrder(data) };
    case "commercial_invoice":
      return { docType, fields: mapCommercialInvoice(data) };
    case "packing_list":
      return { docType, fields: mapPackingList(data) };
    case "quote_sheet":
      return { docType, fields: mapQuoteSheet(data) };
    case "refund_report":
      return { docType, fields: mapRefundReport(data) };
  }
}
