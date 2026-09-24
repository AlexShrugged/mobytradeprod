import { chargeType, documentType } from "@/lib/db/schema";
import type { ChargeTypeValue, DocumentTypeValue } from "@/lib/db/schema";
import type {
  CargoReleaseExtraction,
  CommercialInvoiceExtraction,
  EntryChargeExtraction,
  EntryLineItemExtraction,
  ExtractionCitations,
  ExtractionResult,
  FieldCitations,
  PackingListExtraction,
  PortEntryExtraction,
  PurchaseOrderExtraction,
  QuoteSheetExtraction,
  RefundClaimExtraction,
  RefundReportExtraction,
  ShipmentExtraction,
  TariffCodeSheetExtraction,
  TariffCodeSheetRowExtraction,
} from "../types";
import { canonicalHts } from "../hts-code";
import { PO_NUMBER_MAX } from "../normalize";
import { ProcessingError } from "../types";
import {
  pageResolver,
  pruneCitations,
  recordCitations,
  type PageResolver,
} from "./citations";
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

/** A cited leaf's plain value and the page text its citations point at. */
function citedLeaf(node: unknown): { value: unknown; printed: string[] } {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const record = node as Record<string, unknown>;
    if ("value" in record && Array.isArray(record.citations)) {
      return {
        value: record.value,
        printed: record.citations.flatMap((c) => {
          const content = (c as { content?: unknown } | null)?.content;
          return typeof content === "string" ? [content] : [];
        }),
      };
    }
  }
  return { value: node, printed: [] };
}

const PRINTED_PERCENT = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/;

/** The extractor turns a printed "2.5%" into a decimal fraction itself and
 *  now and then slips a place (0.25 beside a citation reading "2.5%" and a
 *  correct $177.48 — ASC 231-7370776-8, 2026-09-18). A 7501 charge is
 *  self-checking, so the printed figure wins only when BOTH witnesses agree:
 *  every percent the rate cites is the same number, and the charge's own
 *  amount closes against that rate on the line's entered value better than
 *  against the extracted one. Anything else (no percent-shaped citation, a
 *  $0 claim, a 232 metal-content basis) is left exactly as extracted. Runs
 *  on the cited tree, before unwrapCitations discards the page text — and
 *  on a copy: the response is also persisted verbatim as raw_extraction. */
export function repairCitedRates(
  response: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(response.line_items)) return response;
  const data = structuredClone(response);
  for (const line of data.line_items as unknown[]) {
    if (!line || typeof line !== "object") continue;
    const lineRecord = line as Record<string, unknown>;
    const entered = toNum(citedLeaf(lineRecord.entered_value).value);
    if (entered === null || entered <= 0) continue;
    if (!Array.isArray(lineRecord.charges)) continue;
    for (const charge of lineRecord.charges) {
      if (!charge || typeof charge !== "object") continue;
      const chargeRecord = charge as Record<string, unknown>;
      const rate = citedLeaf(chargeRecord.rate);
      const extracted = toNum(rate.value);
      const amount = toNum(citedLeaf(chargeRecord.amount).value);
      if (extracted === null || amount === null || amount <= 0) continue;
      const printed = new Set(
        rate.printed.flatMap((text) => {
          const match = PRINTED_PERCENT.exec(text);
          return match ? [Number(match[1]) / 100] : [];
        }),
      );
      if (printed.size !== 1) continue;
      const [printedRate] = printed;
      if (Math.abs(printedRate - extracted) < 1e-9) continue;
      const missPrinted = Math.abs(amount - printedRate * entered);
      const missExtracted = Math.abs(amount - extracted * entered);
      if (
        missPrinted <= Math.max(0.05, entered * 0.001) &&
        missPrinted < missExtracted
      ) {
        (chargeRecord.rate as Record<string, unknown>).value = printedRate;
      }
    }
  }
  return data;
}

function toStr(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/** A printed unit-of-measure code, capped to the column width. */
function toUnit(v: unknown): string | null {
  const s = toStr(v);
  return s ? s.slice(0, 16) : null;
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

/** A printed line number, else the row's position. Outside 1..9999 the
 *  print is not a line number — the extractor put a part number
 *  ("4385010100") in the column once (ASC 231-7383607-0, 2026-09-24) and
 *  the integer column rejected the whole invoice. */
function toLineNumber(v: unknown, position: number): number {
  const n = toInt(v);
  return n !== null && n >= 1 && n <= 9999 ? n : position;
}

/** ISO country codes compare exact-match downstream (measure gating,
 *  COO-vs-catalog audit) — normalize case here so "cn" never slips through.
 *  Only a two-letter code is a fact the column can hold: a printed dual
 *  origin ("CN/HK", MotoRad 879-4080794-1) or a country name is unknown
 *  origin (never a discrepancy), not a reason to fail the document. */
function toCountry(v: unknown): string | null {
  const s = toStr(v)?.toUpperCase() ?? null;
  return s && /^[A-Z]{2}$/.test(s) ? s : null;
}

/** An HTS/HS code as printed → its canonical form (see hts-code.ts); a
 *  value that is not a single code stays as printed, capped to the column. */
function toHts(v: unknown): string | null {
  return canonicalHts(toStr(v)).code;
}

/** SPI codes are 1-2 letters plus an optional marker ("KR", "A+"); anything
 *  longer is extraction noise, not a claim — drop it rather than persist it. */
function toSpi(v: unknown): string | null {
  const s = toStr(v)?.toUpperCase() ?? null;
  return s && /^[A-Z]{1,2}[*+#]?$/.test(s) ? s : null;
}

/** Normalize to YYYY-MM-DD; accepts ISO datetimes and MM/DD/YYYY. */
const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
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

// The line tables key a line by (document, line_number), so two lines
// printing the same number fail the whole document. Multi-page invoices
// restart their numbering on every page and the extractor sometimes repeats
// a number, so printed numbers are kept only while they are unique; on the
// first collision every line takes its document position instead. Nothing
// downstream reads the number as a fact — comparisons are SKU-grouped
// (audit/invoice-rules.ts) — it is an ordinal for display and identity.
function renumberOnCollision<T extends { line_number: number }>(
  lines: T[],
): T[] {
  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.line_number)) {
      return lines.map((l, i) => ({ ...l, line_number: i + 1 }));
    }
    seen.add(line.line_number);
  }
  return lines;
}

// Where each output row came from in the cited response, so the mapper's
// merges never lose a fact's provenance: a line's source row, and for each
// of its charges the row and charge it was read from. A charge synthesized
// from a supplemental row with no charges of its own (the $0 claim under
// the row's Ch99 code) has no charge index — the code is its evidence.
type ChargeSource = {
  line: number;
  charge: number | null;
  /** The charge printed no code and inherited the supplemental row's. */
  htsFromRow: boolean;
};
type LineSource = { line: number; charges: ChargeSource[] };

function mapLineItemsWithSources(raw: unknown): {
  lines: EntryLineItemExtraction[];
  sources: LineSource[];
} {
  // Lines with no HTS code cannot be declared lines; drop rather than fail
  // the whole document. The position fallback for line_number counts the
  // surviving rows, as before.
  const rows: { line: EntryLineItemExtraction; source: LineSource }[] = [];
  asRecordArray(raw).forEach((line, sourceIndex) => {
    if (toStr(line.hts_code) === null) return;
    const position = rows.length;
    const charges = asRecordArray(line.charges);
    rows.push({
      line: {
        line_number: toLineNumber(line.line_number, position + 1),
        sku: toStr(line.sku),
        description: toStr(line.description),
        hts_code: toHts(line.hts_code) as string,
        spi: toSpi(line.spi),
        country_of_origin: toCountry(line.country_of_origin),
        supplier_name: toStr(line.supplier_name),
        quantity: toNum(line.quantity),
        quantity_unit: toUnit(line.quantity_unit),
        unit_value: toNum(line.unit_value),
        entered_value: toNum(line.entered_value) ?? 0,
        charges: charges.map(mapCharge),
        adcvd_case_number: toStr(line.adcvd_case_number),
        manufacturer_id: toStr(line.manufacturer_id),
      },
      source: {
        line: sourceIndex,
        charges: charges.map((_, charge) => ({
          line: sourceIndex,
          charge,
          htsFromRow: false,
        })),
      },
    });
  });

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
  const byNumber = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = byNumber.get(row.line.line_number);
    if (group) group.push(row);
    else byNumber.set(row.line.line_number, [row]);
  }
  const merged = [...byNumber.values()].map((group) => {
    const base =
      group.find((row) => !isCh99(row.line.hts_code)) ?? group[0];
    if (group.length === 1) return base;
    const charges: EntryChargeExtraction[] = [];
    const chargeSources: ChargeSource[] = [];
    for (const row of group) {
      if (row === base) {
        charges.push(...row.line.charges);
        chargeSources.push(...row.source.charges);
        continue;
      }
      if (row.line.charges.length === 0) {
        charges.push({
          charge_type: "additional_duty" as const,
          hts_code: row.line.hts_code,
          rate: null,
          amount: 0,
        });
        chargeSources.push({
          line: row.source.line,
          charge: null,
          htsFromRow: true,
        });
        continue;
      }
      row.line.charges.forEach((charge, j) => {
        charges.push({
          ...charge,
          hts_code: charge.hts_code ?? row.line.hts_code,
        });
        chargeSources.push({
          ...row.source.charges[j],
          htsFromRow: charge.hts_code === null,
        });
      });
    }
    return {
      line: { ...base.line, charges },
      source: { line: base.source.line, charges: chargeSources },
    };
  });
  return {
    lines: merged.map((row) => row.line),
    sources: merged.map((row) => row.source),
  };
}

const PORT_ENTRY_HEADER_FIELDS = [
  "entry_number",
  "entry_date",
  "port_of_entry",
  "entry_type",
  "importer_of_record",
  "total_entered_value",
  "total_duty",
  "mpf_amount",
  "hmf_amount",
  "bond_type",
  "surety_number",
] as const;
const ENTRY_LINE_FIELDS = [
  "line_number",
  "sku",
  "description",
  "hts_code",
  "spi",
  "country_of_origin",
  "supplier_name",
  "quantity",
  "quantity_unit",
  "unit_value",
  "entered_value",
  "adcvd_case_number",
  "manufacturer_id",
] as const;
const ENTRY_CHARGE_FIELDS = ["charge_type", "hts_code", "rate", "amount"] as const;

/** Provenance for a mapped 7501, keyed by the OUTPUT shape (line position,
 *  charge position) — read off the cited tree by the sources the merge
 *  recorded, so a folded supplemental row's charges still point at the
 *  cells they were read from. */
function portEntryCitations(
  cited: Record<string, unknown>,
  sources: LineSource[],
  pageOf: PageResolver,
): ExtractionCitations {
  const citedLines = asRecordArray(cited.line_items);
  return {
    header: recordCitations(cited, PORT_ENTRY_HEADER_FIELDS, pageOf),
    lines: sources.map((source) => ({
      fields: recordCitations(citedLines[source.line], ENTRY_LINE_FIELDS, pageOf),
      charges: source.charges.map((chargeSource) => {
        const row = citedLines[chargeSource.line];
        const rowCode = recordCitations(row, ["hts_code"], pageOf).hts_code;
        if (chargeSource.charge === null) {
          // The $0 claim is not printed; the supplemental row's code is
          // what the filing shows.
          return rowCode ? { hts_code: rowCode } : {};
        }
        const charge: FieldCitations = recordCitations(
          asRecordArray(row?.charges)[chargeSource.charge],
          ENTRY_CHARGE_FIELDS,
          pageOf,
        );
        if (chargeSource.htsFromRow && rowCode) charge.hts_code = rowCode;
        return charge;
      }),
    })),
  };
}

function mapPortEntryWithSources(data: Record<string, unknown>): {
  fields: PortEntryExtraction;
  sources: LineSource[];
} {
  const { lines, sources } = mapLineItemsWithSources(data.line_items);
  const fields: PortEntryExtraction = {
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
    line_items: lines,
    adcvd_case_numbers: toStrArray(data.adcvd_case_numbers),
    bond_type: toStr(data.bond_type),
    surety_number: toStr(data.surety_number),
    related_party: toBool(data.related_party),
  };
  return { fields, sources };
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
    po_number: required(
      toStr(data.po_number)?.slice(0, PO_NUMBER_MAX) ?? null,
      "purchase order number",
    ),
    supplier_name: toStr(data.supplier_name),
    order_date: toDate(data.order_date),
    currency: toStr(data.currency) ?? "USD",
    total_amount: toNum(data.total_amount),
    // Map before filtering so the position fallback for line_number
    // reflects the document, not the surviving subset.
    line_items: renumberOnCollision(
      asRecordArray(data.line_items)
        .map((line, i) => ({
          line_number: toLineNumber(line.line_number, i + 1),
          sku: toStr(line.sku),
          description: toStr(line.description),
          country_of_origin: toCountry(line.country_of_origin),
          quantity: toNum(line.quantity) ?? 0,
          unit_price: toNum(line.unit_price) ?? 0,
        }))
        .filter(
          (line): line is typeof line & { sku: string } => line.sku !== null,
        ),
    ),
  };
}

const INVOICE_HEADER_FIELDS = [
  "invoice_number",
  "po_number",
  "supplier_name",
  "invoice_date",
  "currency",
  "amount",
  "subtotal",
  "incoterms",
  "payment_terms",
] as const;
const INVOICE_LINE_FIELDS = [
  "line_number",
  "sku",
  "description",
  "country_of_origin",
  "hts_code",
  "quantity",
  "quantity_unit",
  "unit_price",
  "total_price",
  "adcvd_case_number",
  "manufacturer_name",
] as const;

function mapCommercialInvoiceWithSources(data: Record<string, unknown>): {
  fields: CommercialInvoiceExtraction;
  /** Source index (into the cited line_items) of each output line. */
  sources: number[];
} {
  // Map before filtering so the position fallback for line_number
  // reflects the document, not the surviving subset. Renumbering keeps
  // order, so the sources stay aligned with the lines.
  const mapped = asRecordArray(data.line_items)
    .map((line, i) => ({
      source: i,
      line: {
        line_number: toLineNumber(line.line_number, i + 1),
        sku: toStr(line.sku),
        description: toStr(line.description),
        country_of_origin: toCountry(line.country_of_origin),
        hts_code: toHts(line.hts_code),
        quantity: toNum(line.quantity),
        quantity_unit: toUnit(line.quantity_unit),
        unit_price: toNum(line.unit_price),
        total_price: toNum(line.total_price),
        adcvd_case_number: toStr(line.adcvd_case_number),
        manufacturer_name: toStr(line.manufacturer_name),
      },
    }))
    .filter(
      (
        row,
      ): row is typeof row & {
        line: (typeof row)["line"] & { total_price: number };
      } => row.line.total_price !== null,
    );
  const fields: CommercialInvoiceExtraction = {
    invoice_number: required(toStr(data.invoice_number), "invoice number"),
    po_number: toStr(data.po_number),
    supplier_name: toStr(data.supplier_name),
    invoice_date: toDate(data.invoice_date),
    currency: toStr(data.currency) ?? "USD",
    amount: toNum(data.amount),
    subtotal: toNum(data.subtotal),
    // An adjustment without an amount reconciles nothing — dropped. One
    // without a label is still a fact the arithmetic needs.
    adjustments: asRecordArray(data.adjustments)
      .map((row) => ({
        label: toStr(row.label) ?? "Adjustment",
        amount: toNum(row.amount),
      }))
      .filter(
        (row): row is typeof row & { amount: number } => row.amount !== null,
      ),
    incoterms: toStr(data.incoterms),
    payment_terms: toStr(data.payment_terms),
    related_party: toBool(data.related_party),
    line_items: renumberOnCollision(mapped.map((row) => row.line)),
  };
  return { fields, sources: mapped.map((row) => row.source) };
}

function invoiceCitations(
  cited: Record<string, unknown>,
  sources: number[],
  pageOf: PageResolver,
): ExtractionCitations {
  const citedLines = asRecordArray(cited.line_items);
  return {
    header: recordCitations(cited, INVOICE_HEADER_FIELDS, pageOf),
    lines: sources.map((source) => ({
      fields: recordCitations(citedLines[source], INVOICE_LINE_FIELDS, pageOf),
      charges: [],
    })),
  };
}

function mapTariffCodeSheet(
  data: Record<string, unknown>,
): TariffCodeSheetExtraction {
  // The printed table repeats a part once per tariff number in its line's
  // Chapter 99 stack; the schema asks the extractor to collapse that, but
  // dedupe here anyway — the linker upserts by (entry, line, sku) and a
  // duplicate pair would be a conflict, not a fact. A row whose part number
  // is tariff-heading noise or whose line number is missing maps nothing.
  const seen = new Set<string>();
  const rows: TariffCodeSheetRowExtraction[] = [];
  for (const row of asRecordArray(data.rows)) {
    const lineNumber = toInt(row.entry_line_number);
    const partNumber = toStr(row.part_number);
    if (lineNumber === null || partNumber === null) continue;
    // Tariff numbers leaking into the part column (9903.88.03, 7307191030)
    // are extraction noise, never part identity.
    if (/^\d{4}\.\d{2}\.\d{2,4}$/.test(partNumber)) continue;
    const key = `${lineNumber}:${partNumber.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      entry_line_number: lineNumber,
      part_number: partNumber,
      po_number: toStr(row.po_number),
      description: toStr(row.description),
    });
  }
  if (rows.length === 0) {
    throw new ProcessingError(
      "Extraction did not find any line-to-part rows in the tariff code sheet.",
    );
  }
  return {
    entry_number: required(toStr(data.entry_number), "entry number"),
    broker_ref: toStr(data.broker_ref),
    referenced_invoices: toStrArray(data.referenced_invoices),
    rows,
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
  const lineItems = renumberOnCollision(
    asRecordArray(data.line_items)
      .map((line, i) => ({
        line_number: toLineNumber(line.line_number, i + 1),
        sku: toStr(line.sku),
        description: toStr(line.description),
        unit_cost: toNum(line.unit_cost),
        currency: toStr(line.currency),
        country_of_origin: toCountry(line.country_of_origin),
        hts_code: toHts(line.hts_code),
        moq: toNum(line.moq),
        lead_time_days: toInt(line.lead_time_days),
        unit_of_measure: toStr(line.unit_of_measure),
      }))
      .filter(
        (line): line is typeof line & { sku: string; unit_cost: number } =>
          line.sku !== null && line.unit_cost !== null,
      ),
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
  return mapExtractWithCitations(docType, result).extraction;
}

/** The mapped facts AND where each was read. Citations are keyed by the
 *  output shape and null for document classes whose facts are not
 *  persisted row by row. pageRange is the packet child's page scope, the
 *  fallback for a payload naming no original_page. */
export function mapExtractWithCitations(
  docType: ExtractableDocType,
  result: unknown,
  opts: { pageRange?: number[] | null } = {},
): { extraction: ExtractionResult; citations: ExtractionCitations | null } {
  const merged = mergeResultChunks(result);
  const cited = docType === "port_entry" ? repairCitedRates(merged) : merged;
  const data = asRecord(unwrapCitations(cited));
  const pageOf = pageResolver(opts.pageRange);
  switch (docType) {
    case "port_entry": {
      const { fields, sources } = mapPortEntryWithSources(data);
      return {
        extraction: { docType, fields },
        citations: pruneCitations(
          fields,
          portEntryCitations(cited, sources, pageOf),
        ),
      };
    }
    case "commercial_invoice": {
      const { fields, sources } = mapCommercialInvoiceWithSources(data);
      return {
        extraction: { docType, fields },
        citations: pruneCitations(fields, invoiceCitations(cited, sources, pageOf)),
      };
    }
    case "cargo_release":
      return { extraction: { docType, fields: mapCargoRelease(data) }, citations: null };
    case "shipment":
      return { extraction: { docType, fields: mapShipment(data) }, citations: null };
    case "purchase_order":
      return { extraction: { docType, fields: mapPurchaseOrder(data) }, citations: null };
    case "packing_list":
      return { extraction: { docType, fields: mapPackingList(data) }, citations: null };
    case "tariff_code_sheet":
      return { extraction: { docType, fields: mapTariffCodeSheet(data) }, citations: null };
    case "quote_sheet":
      return { extraction: { docType, fields: mapQuoteSheet(data) }, citations: null };
    case "refund_report":
      return { extraction: { docType, fields: mapRefundReport(data) }, citations: null };
  }
}
