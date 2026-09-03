// The demo story: one e-bike importer's last ~6 months of import activity,
// every date anchored to seed day via the day()/at() helpers so the demo
// never goes stale. All values are fixed literals or fixed formulas — no
// randomness anywhere.
//
// Derived data is NEVER seeded: no audit_alerts (the auditor computes
// them), no review_items/hts_classifications (the classification service
// lands later — parts carry only the projection column), no "pending
// changes" flags (derived from quote_lines on read). The one review item the
// seed does hold is derived too: scripts/seed.ts runs the quote reconsider
// sweep over the finished book (QS5 below).
//
// Planted audit findings (surfaced by the auditor, seeded as declared
// facts here). Entry 231-4501311-9 carries the money findings:
//   line 1 — Section 301 List 1 declared at 20% instead of the official 25%
//   line 2 — Section 301 List 3 charge missing entirely
//   line 3 — a $0 exclusion claim (9903.88.67) in place of List 3 — a
//            statement, not an underpayment; must never be flagged
// Entry 231-4501341-1 carries the sourcing finding:
//   line 2 — EB-CTRL-V2 declared with origin CN under supplier Hanoi
//            Precision Components, whose catalog source is VN — the
//            coo_discrepancy rule (charges match the declared CN, so the
//            money rules stay quiet; the 301 duty may be refundable).
// Entry 231-4501320-0 carries the classification finding:
//   line 1 — EB-BRK-HYD declared under 8714.94.9000 (10%) while the
//            catalog classifies it 8714.94.3080 (free) — hts_discrepancy;
//            charges are consistent under the declared code, so the ~$1,620
//            base duty may be recoverable.
// Entry 231-4501293-1 carries the RECLASSIFICATION finding:
//   line 1 — EB-DSP-LCD declared under 8531.80.9051 (1.3%), which WAS the
//            catalog code on its day(-140) entry date; the part was
//            reclassified to the Free 8531.20.0040 at day(-40) (see
//            CLASSIFICATION_WINDOWS) — hts_reclassified, not a misfiling:
//            the filing matched its day's expectation, and the base duty
//            may be retroactively recoverable.
// Entry 231-4501347-8 is the STACKED line — every issue class that can
//   coexist on ONE line at once (the broker keyed the 7501 from a stale
//   invoice revision): 60 of 65 batteries entered (quantity + value vs the
//   CI, gated open by the header failure), base duty at 6.5% instead of
//   3.4% (rate + amount pair), the 10% reciprocal omitted entirely
//   (missing_measure), and a CI that prints HS 8507.80 and origin VN
//   (invoice_hts_mismatch + coo_discrepancy). Deliberately NO catalog
//   hts_discrepancy — classification doubt would suspend the money rules.
//
// Planted ANALYSIS defects (invisible to the deterministic rules BY DESIGN —
// the AI entry analyst's eval ground truth; see seed-data/analysis-defects.ts
// and scripts/analyze-entry.ts). All three entries must audit deterministically
// CLEAN — seed.ts asserts it:
// Entry 231-4501352-6 — MPF below the statutory minimum: a tiny entry
//   ($2,940) whose broker filed the uncapped ad valorem MPF ($10.18) instead
//   of applying the per-entry minimum. The deterministic rules skip MPF/HMF
//   entirely (ingested facts), so only the analyst can catch it.
// Entry 231-4501358-3 — AD/CVD case-number discrepancy: a type 03 entry
//   whose 7501 references case A-570-121 while the commercial invoice
//   (INV-2026-215) prints A-570-133. Case numbers live only in document
//   extracted_data (no column exists); the declared antidumping charge
//   carries no Ch99 code, so the money rules skip it.
// Entry 231-4501364-1 — description/HTS mismatch: line 2 is described as a
//   lithium battery ("48V 10Ah Range-Extender Lithium Battery") but filed
//   under the saddle code 8714.95.0000 (301 List 3 at 7.5% instead of the
//   battery heading's 25%). The SKU (EB-PWR-EXT) is not in the catalog, so
//   no catalog comparison fires and the charges are self-consistent under
//   the declared code — the DEFECT stays analyst-only. Rule 16 does flag
//   the coverage gap itself (unknown_sku:line2, asserted in seed.ts): a
//   deliberate demo of the unknown-SKU variance, not a leak of the plant.

import type {
  ChargeTypeValue,
  DocumentTypeValue,
  IntegrationKind,
  IntegrationStatusValue,
  PacketRoleValue,
  PartHtsReviewStatusValue,
  PartStatus,
  QuoteLineStatus,
} from "../schema";
import { normalizeHts } from "../../duty/calculator";
import { HMF_RATE, MPF_RATE } from "../../duty/fees";
import { HTS_SEED } from "./tariff";
import type { DayFn } from "./tariff";

/** Date `offset` days from seed day at a fixed UTC time. */
export type AtFn = (offset: number, hour: number, minute?: number) => Date;

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- org

export const ORG_SEED = {
  name: "Waystar Royco",
  importerOfRecord: "Waystar Royco, Inc.",
  inboxAddress: "docs@waystar.mobytrade.app",
  // The demo's one human operator — surfaces as actor/decidedBy on manual
  // edits until auth lands.
  defaultActorName: "Alex",
};

// ------------------------------------------------------- vendors & parts
//
// Vendor names are CANONICAL everywhere (no "Co."/"Ltd."/"JSC" drift):
// resolution is trim+casefold only, so a suffix would mint a second vendor.
// Ningbo E-Drive Systems exists only through quote sheet QS1 — a vendor
// with quotes but no catalog source yet.
//
// 12 parts: 9 plain active, plus EB-SDL-CMF (active; its approved quote
// awaiting a PO makes it "pending changes" — derived, never stored),
// EB-CHG-48V (active; HTS review projection "pending", queue rows land with
// the classification service), and EB-CHG-52V (draft; created by quote
// sheet QS4 for an unknown SKU — carries the quote's cost, not an official
// one).
//
// COO and cost live on the (part, vendor) SOURCES — the SKU alone does not
// define them. EB-CTRL-V2 is the dual-sourcing flagship: the same
// controller from Shenzhen Volt Dynamics (CN, $42.30) and Hanoi Precision
// Components (VN, $44.10). Section 301 applies to the CN source only, so
// the VN source lands cheaper despite the higher unit cost.

export const VENDOR_SEED = [
  "Shenzhen Volt Dynamics",
  "Taichung Cycle Works",
  "Hanoi Precision Components",
  "Hangzhou Comfort Components",
  "Ningbo E-Drive Systems",
] as const;

export type PartSourceSeed = {
  vendor: string;
  countryOfOrigin: string;
  unitCost: string;
};

export type PartSeed = {
  sku: string;
  name: string;
  htsCode: string | null;
  /** First source = the primary (drives entry-line defaults and the stub). */
  sources: PartSourceSeed[];
  status: PartStatus;
  htsReviewStatus: PartHtsReviewStatusValue | null;
};

const SHENZHEN = "Shenzhen Volt Dynamics";
const TAICHUNG = "Taichung Cycle Works";
const HANOI = "Hanoi Precision Components";
const HANGZHOU = "Hangzhou Comfort Components";

const src = (
  vendor: string,
  countryOfOrigin: string,
  unitCost: string,
): PartSourceSeed => ({ vendor, countryOfOrigin, unitCost });

export const PART_SEED: PartSeed[] = [
  { sku: "EB-MTR-750W", name: "750W Mid-Drive Motor", htsCode: "8501.31.4000", sources: [src(SHENZHEN, "CN", "289.5000")], status: "active", htsReviewStatus: null },
  { sku: "EB-MTR-500W", name: "500W Geared Hub Motor", htsCode: "8501.31.4000", sources: [src(SHENZHEN, "CN", "148.0000")], status: "active", htsReviewStatus: null },
  { sku: "EB-BAT-48V", name: "48V 14Ah Lithium Battery Pack", htsCode: "8507.60.0020", sources: [src(SHENZHEN, "CN", "312.0000")], status: "active", htsReviewStatus: null },
  { sku: "EB-BAT-52V", name: "52V 20Ah Lithium Battery Pack", htsCode: "8507.60.0020", sources: [src(SHENZHEN, "CN", "428.7500")], status: "active", htsReviewStatus: null },
  // Dual-sourced: same controller, two vendors, two origins — the landed
  // estimates diverge because Section 301 gates on CN only.
  { sku: "EB-CTRL-V2", name: "Sine-Wave Motor Controller V2", htsCode: "8504.40.9550", sources: [src(SHENZHEN, "CN", "42.3000"), src(HANOI, "VN", "44.1000")], status: "active", htsReviewStatus: null },
  { sku: "EB-DSP-LCD", name: "Backlit LCD Display Unit", htsCode: "8531.20.0040", sources: [src(TAICHUNG, "TW", "28.9000")], status: "active", htsReviewStatus: null },
  { sku: "EB-FRM-MTB", name: "Hardtail MTB Alloy Frame", htsCode: "8714.91.3000", sources: [src(TAICHUNG, "TW", "104.5000")], status: "active", htsReviewStatus: null },
  { sku: "EB-BRK-HYD", name: "Hydraulic Disc Brake Set", htsCode: "8714.94.3080", sources: [src(TAICHUNG, "TW", "64.8000")], status: "active", htsReviewStatus: null },
  { sku: "EB-WHL-27F", name: '27.5" Front Wheel, Thru-Axle', htsCode: "8714.92.1000", sources: [src(HANOI, "VN", "38.6000")], status: "active", htsReviewStatus: null },
  // Active, with an approved quote awaiting its PO (see QS2 / PO-2026-010).
  { sku: "EB-SDL-CMF", name: "Comfort Gel Saddle", htsCode: "8714.95.0000", sources: [src(HANGZHOU, "CN", "9.8000")], status: "active", htsReviewStatus: null },
  // Codeless — HTS review projection only; classification rows land in a
  // later phase.
  { sku: "EB-CHG-48V", name: "48V 3A Battery Charger", htsCode: null, sources: [src(SHENZHEN, "CN", "18.5000")], status: "active", htsReviewStatus: "pending" },
  // Draft — created by quote sheet QS4 for an unknown SKU; its source
  // carries the quote's cost, not an official one.
  { sku: "EB-CHG-52V", name: "52V 4A Fast Charger", htsCode: null, sources: [src(SHENZHEN, "CN", "21.7500")], status: "draft", htsReviewStatus: null },
];

const partBySku = new Map(PART_SEED.map((p) => [p.sku, p]));

function part(sku: string): PartSeed {
  const p = partBySku.get(sku);
  if (!p) throw new Error(`story references unknown SKU ${sku}`);
  return p;
}

/** The part's primary source — first in the list. */
function primary(p: PartSeed): PartSourceSeed {
  if (p.sources.length === 0) throw new Error(`part ${p.sku} has no sources`);
  return p.sources[0];
}

// ------------------------------------------------- declared-charge builder
//
// Mirrors MEASURE_SEED's applicability (301 lists by CN + prefix, 232
// aluminum on 871491 which suppresses the reciprocal via stacking, the 10%
// reciprocal on everything else). Hand-wired on purpose: the seed states
// declared FACTS; the duty calculator independently derives expectations
// from reference data, which is exactly what makes the planted findings
// findable. No Section 122 rows: every seeded entry predates the day(-10)
// cutoff.

const BASE_RATE = new Map(
  HTS_SEED.map((h) => [normalizeHts(h.code), h.rate] as const),
);

const S301_LISTS = [
  { prefixes: ["8501", "8504", "8531"], ch99: "9903.88.01", rate: 0.25 },
  { prefixes: ["8507", "7315", "7318"], ch99: "9903.88.03", rate: 0.25 },
  { prefixes: ["8714", "8512", "4011", "4013"], ch99: "9903.88.15", rate: 0.075 },
];
const S232_ALU = { prefix: "871491", ch99: "9903.85.08", rate: 0.25 };
const RECIPROCAL = { ch99: "9903.01.25", rate: 0.1 };

export type ChargeSeed = {
  chargeType: ChargeTypeValue;
  htsCode: string | null;
  rate: number | null;
  amount: number; // dollars
};

function declaredCharges(
  htsCode: string,
  coo: string,
  enteredValue: number,
  opts: { hmf: boolean },
): ChargeSeed[] {
  const digits = normalizeHts(htsCode);
  const charges: ChargeSeed[] = [];

  const baseRate = BASE_RATE.get(digits);
  if (baseRate !== undefined && baseRate !== null && baseRate > 0) {
    charges.push({
      chargeType: "base_duty",
      htsCode,
      rate: baseRate,
      amount: round2(baseRate * enteredValue),
    });
  }

  if (coo === "CN") {
    const list = S301_LISTS.find((l) =>
      l.prefixes.some((p) => digits.startsWith(p)),
    );
    if (list) {
      charges.push({
        chargeType: "additional_duty",
        htsCode: list.ch99,
        rate: list.rate,
        amount: round2(list.rate * enteredValue),
      });
    }
  }

  if (digits.startsWith(S232_ALU.prefix)) {
    // Section 232 aluminum; the stacking rule suppresses the reciprocal.
    charges.push({
      chargeType: "additional_duty",
      htsCode: S232_ALU.ch99,
      rate: S232_ALU.rate,
      amount: round2(S232_ALU.rate * enteredValue),
    });
  } else {
    charges.push({
      chargeType: "additional_duty",
      htsCode: RECIPROCAL.ch99,
      rate: RECIPROCAL.rate,
      amount: round2(RECIPROCAL.rate * enteredValue),
    });
  }

  // MPF/HMF as the filer declared them — ingested facts. No HMF on air.
  charges.push({
    chargeType: "mpf",
    htsCode: "499",
    rate: MPF_RATE,
    amount: round2(MPF_RATE * enteredValue),
  });
  if (opts.hmf) {
    charges.push({
      chargeType: "hmf",
      htsCode: "501",
      rate: HMF_RATE,
      amount: round2(HMF_RATE * enteredValue),
    });
  }
  return charges;
}

// ---------------------------------------------------------------- story

export type EntryLineSeed = {
  lineNumber: number;
  sku: string;
  description: string;
  htsCode: string;
  countryOfOrigin: string;
  /** Per-line supplier as printed on the 7501 (entries can span vendors). */
  supplierName: string;
  quantity: number;
  unitValue: number;
  enteredValue: number;
  charges: ChargeSeed[];
};

export type EntrySeed = {
  entryNumber: string;
  entryDate: string;
  portOfEntry: string;
  entryType: string;
  totalRefund: number | null;
  lines: EntryLineSeed[];
  totals: {
    enteredValue: number;
    duty: number;
    baseDuty: number;
    mpf: number;
    hmf: number | null; // null = no HMF declared (air entry)
  };
};

export type ShipmentSeed = {
  shipmentNumber: string;
  billOfLading: string;
  containerNumber: string | null;
  carrier: string;
  vessel: string | null;
  mode: "ocean" | "air";
  originPort: string;
  destinationPort: string;
  etd: string;
  eta: string;
  sailedOnBoardDate: string | null;
  // No status: lifecycle state derives on read from the dates + entry
  // links (shipments/status.ts).
};

export type PoLineSeed = {
  lineNumber: number;
  sku: string;
  /** Origin as logged on the PO line, when the document carries one. */
  countryOfOrigin?: string;
  quantity: number;
  unitPrice: number;
};

export type PoSeed = {
  poNumber: string;
  supplierName: string;
  orderDate: string;
  expectedDate: string;
  lines: PoLineSeed[];
  totalAmount: number;
};

export type RefundClaimSeed = {
  key: "RC1" | "RC2";
  entryNumber: string;
  claimType: string;
  claimStatus: string;
  refundStatus: string;
  refundNumber: string | null;
  refundClassAmount: string;
  refundInterestAmount: string;
  entryDate: string;
  liquidationDate: string;
  refundDate: string | null;
};

export type QuoteLineSeed = {
  lineNumber: number;
  sku: string;
  partCreated: boolean;
  description: string;
  unitCost: string;
  countryOfOrigin: string;
  htsCode: string | null;
  moq: string | null;
  leadTimeDays: number | null;
  status: QuoteLineStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  appliedAt: Date | null;
  appliedPoLineRef: { poNumber: string; lineNumber: number } | null;
};

export type QuoteSheetSeed = {
  key: "QS1" | "QS2" | "QS3" | "QS4" | "QS5";
  supplierName: string;
  quoteDate: string;
  validUntil: string | null;
  notes: string | null;
  documentFile: string | null; // fileName of the quote_sheet document
  lines: QuoteLineSeed[];
};

export type SourceSeed = {
  kind: IntegrationKind;
  name: string;
  status: IntegrationStatusValue;
  config: Record<string, unknown>;
  lastReceivedAt: Date | null;
  lastRunAt: Date | null;
};

export type RuleSeed = {
  text: string;
  suppression: Record<string, unknown> | null;
  enabled: boolean;
  source: "manual" | "assistant";
  createdByName: string;
};

export type DocLinkSeed = {
  entityType:
    | "entry"
    | "shipment"
    | "purchase_order"
    | "invoice"
    | "quote_sheet"
    | "refund_claim"
    | "part";
  key: string; // entryNumber | shipmentNumber | poNumber | invoiceNumber | QS key | RC key | sku
  created: boolean;
};

export type DocumentSeed = {
  fileName: string;
  docType: DocumentTypeValue;
  sourceKind: "manual_upload" | "sftp" | "email_inbox";
  uploadedAt: Date;
  extractedData: unknown;
  links: DocLinkSeed[];
  /** Page count of the placeholder PDF (packet parents are multi-page). */
  pages?: number;
  /** Set on packet children: they share the parent's file (storageKey) and
   *  carry a role + the 1-indexed pages of the parent PDF they cover. The
   *  parent must appear BEFORE its children in the documents list. */
  packet?: {
    parentFileName: string;
    role: PacketRoleValue;
    pageRange: number[];
  };
};

export type InvoiceLineSeed = {
  lineNumber: number;
  sku: string;
  description: string;
  /** HTS/HS code as printed on the invoice line; null = the CI omits one. */
  htsCode: string | null;
  countryOfOrigin: string | null;
  quantity: number;
  unitPrice: number;
  /** Extended total; defaults to qty × unit — an override IS a plant. */
  totalPrice?: number;
  /** AD/CVD case number as printed on the CI line. Document-only: it lands
   *  in the CI's extracted_data (no invoice column exists) — the analysis
   *  corpus, not the relational model. */
  adcvdCaseNumber?: string;
};

export type InvoiceSeed = {
  invoiceNumber: string;
  poNumber: string;
  supplierName: string;
  invoiceDate: string;
  currency: string;
  totalAmount: number;
  incoterms: string | null;
  lines: InvoiceLineSeed[];
};

/** An effective-dated classification window for one part. Parts absent
 *  from the windows list get a single open-start current window derived
 *  from their htsCode; parts listed here get exactly these windows (the
 *  seed's reclassification history). */
export type ClassificationWindowSeed = {
  sku: string;
  htsCode: string;
  validFrom: string | null; // null = open start
  validTo: string | null; // null = current
  source: string;
  actor: string | null;
  note: string | null;
  /** When the decision was recorded (created_at); also stamps the matching
   *  field_changes row so the events feed dates the reclassification. */
  recordedAt: Date;
};

export type Story = {
  org: typeof ORG_SEED;
  parts: PartSeed[];
  classificationWindows: ClassificationWindowSeed[];
  purchaseOrders: PoSeed[];
  shipments: ShipmentSeed[];
  entries: EntrySeed[];
  entryShipmentLinks: [entryNumber: string, shipmentNumber: string][];
  entryPoLinks: [entryNumber: string, poNumber: string][];
  shipmentPoLinks: [shipmentNumber: string, poNumber: string][];
  invoices: InvoiceSeed[];
  entryInvoiceLinks: [entryNumber: string, invoiceNumber: string][];
  refundClaims: RefundClaimSeed[];
  quoteSheets: QuoteSheetSeed[];
  integrationSources: SourceSeed[];
  orgRules: RuleSeed[];
  documents: DocumentSeed[];
};

export function buildStory(day: DayFn, at: AtFn, hoursAgo: (h: number) => Date): Story {
  // ------------------------------------------------------ purchase orders
  //
  // PO-2026-005 line 1 is the applied quote QS3's confirmation line.
  // PO-2026-009 rides the in-transit SHP-1008 — the future-entry exposure.
  // PO-2026-010 is the OPEN PO matching approved quote QS2: same part,
  // unit price 9.18 within 0.5% of the quoted 9.15, ordered day(-3) after
  // the day(-9) quote — the awaiting-arrival scenario.
  const purchaseOrders: PoSeed[] = [
    { poNumber: "PO-2026-001", supplierName: SHENZHEN, orderDate: day(-205), expectedDate: day(-172), lines: [
      { lineNumber: 1, sku: "EB-MTR-750W", countryOfOrigin: "CN", quantity: 100, unitPrice: 289.5 },
      { lineNumber: 2, sku: "EB-BAT-48V", countryOfOrigin: "CN", quantity: 80, unitPrice: 312.0 },
    ], totalAmount: 53910.0 },
    { poNumber: "PO-2026-002", supplierName: TAICHUNG, orderDate: day(-175), expectedDate: day(-142), lines: [
      { lineNumber: 1, sku: "EB-DSP-LCD", countryOfOrigin: "TW", quantity: 200, unitPrice: 28.9 },
      // Pre-quote price for EB-BRK-HYD (66.20); QS3's application later
      // set the official cost to 64.80 — per-SKU price history.
      { lineNumber: 2, sku: "EB-BRK-HYD", countryOfOrigin: "TW", quantity: 150, unitPrice: 66.2 },
    ], totalAmount: 15710.0 },
    { poNumber: "PO-2026-003", supplierName: SHENZHEN, orderDate: day(-172), expectedDate: day(-140), lines: [
      { lineNumber: 1, sku: "EB-MTR-500W", countryOfOrigin: "CN", quantity: 120, unitPrice: 148.0 },
      { lineNumber: 2, sku: "EB-CTRL-V2", countryOfOrigin: "CN", quantity: 300, unitPrice: 42.3 },
      { lineNumber: 3, sku: "EB-BAT-52V", countryOfOrigin: "CN", quantity: 60, unitPrice: 428.75 },
    ], totalAmount: 56175.0 },
    { poNumber: "PO-2026-004", supplierName: SHENZHEN, orderDate: day(-115), expectedDate: day(-82), lines: [
      { lineNumber: 1, sku: "EB-MTR-750W", countryOfOrigin: "CN", quantity: 120, unitPrice: 289.5 },
      { lineNumber: 2, sku: "EB-BAT-48V", countryOfOrigin: "CN", quantity: 100, unitPrice: 312.0 },
      { lineNumber: 3, sku: "EB-BAT-52V", countryOfOrigin: "CN", quantity: 40, unitPrice: 428.75 },
    ], totalAmount: 83090.0 },
    { poNumber: "PO-2026-005", supplierName: TAICHUNG, orderDate: day(-98), expectedDate: day(-58), lines: [
      { lineNumber: 1, sku: "EB-BRK-HYD", countryOfOrigin: "TW", quantity: 250, unitPrice: 64.8 },
    ], totalAmount: 16200.0 },
    { poNumber: "PO-2026-006", supplierName: TAICHUNG, orderDate: day(-96), expectedDate: day(-58), lines: [
      { lineNumber: 1, sku: "EB-FRM-MTB", countryOfOrigin: "TW", quantity: 130, unitPrice: 104.5 },
    ], totalAmount: 13585.0 },
    // The Hanoi PO carries the VN-sourced controller — the paper trail
    // behind EB-CTRL-V2's second source.
    { poNumber: "PO-2026-007", supplierName: HANOI, orderDate: day(-70), expectedDate: day(-28), lines: [
      { lineNumber: 1, sku: "EB-WHL-27F", countryOfOrigin: "VN", quantity: 180, unitPrice: 39.2 },
      { lineNumber: 2, sku: "EB-SDL-CMF", countryOfOrigin: "CN", quantity: 400, unitPrice: 9.8 },
      { lineNumber: 3, sku: "EB-CTRL-V2", countryOfOrigin: "VN", quantity: 150, unitPrice: 44.1 },
    ], totalAmount: 17591.0 },
    { poNumber: "PO-2026-008", supplierName: TAICHUNG, orderDate: day(-40), expectedDate: day(-13), lines: [
      { lineNumber: 1, sku: "EB-DSP-LCD", countryOfOrigin: "TW", quantity: 250, unitPrice: 29.4 },
      { lineNumber: 2, sku: "EB-CTRL-V2", quantity: 150, unitPrice: 43.1 },
    ], totalAmount: 13815.0 },
    // Rides the in-transit SHP-1008: the dual-sourced controller on the
    // Shenzhen PO exercises the vendor-matched COO in the future-entry
    // projection (line COO deliberately unlogged — the source resolves it).
    { poNumber: "PO-2026-009", supplierName: SHENZHEN, orderDate: day(-30), expectedDate: day(6), lines: [
      { lineNumber: 1, sku: "EB-MTR-750W", quantity: 150, unitPrice: 289.5 },
      { lineNumber: 2, sku: "EB-BAT-48V", quantity: 120, unitPrice: 315.0 },
      { lineNumber: 3, sku: "EB-CTRL-V2", quantity: 200, unitPrice: 42.3 },
    ], totalAmount: 89685.0 },
    { poNumber: "PO-2026-010", supplierName: HANGZHOU, orderDate: day(-3), expectedDate: day(30), lines: [
      { lineNumber: 1, sku: "EB-SDL-CMF", countryOfOrigin: "CN", quantity: 500, unitPrice: 9.18 },
    ], totalAmount: 4590.0 },
    // Backs the stacked-findings entry: 65 batteries ordered and invoiced —
    // the ENTRY (60 entered) is the odd one out.
    { poNumber: "PO-2026-011", supplierName: SHENZHEN, orderDate: day(-52), expectedDate: day(-16), lines: [
      { lineNumber: 1, sku: "EB-BAT-52V", countryOfOrigin: "CN", quantity: 65, unitPrice: 428.75 },
    ], totalAmount: 27868.75 },
  ];

  // ------------------------------------------------------------ shipments
  //
  // SHP-1006 deliberately has NO sailed-on-board date — it exercises the
  // ETD-estimated sail fallback (`~ETD`; sail_date_assumption stays quiet
  // here because no seeded entry date reaches the Section 122 window).
  // SHP-1008 is the on-the-water demo: sailed day(-13), BEFORE the Section
  // 122 cutoff of day(-10), ETA day(+4), no entry — the future-entry
  // projection with the savings-clause deadline chip.
  const shipments: ShipmentSeed[] = [
    { shipmentNumber: "SHP-1001", billOfLading: "MAEU2264101", containerNumber: "MSKU4471820", carrier: "Maersk", vessel: "MAERSK ESSEX", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Los Angeles, CA", etd: day(-191), eta: day(-172), sailedOnBoardDate: day(-190) },
    { shipmentNumber: "SHP-1002", billOfLading: "ONEY8811327", containerNumber: "ONEU2203945", carrier: "Ocean Network Express", vessel: "ONE HARBOUR", mode: "ocean", originPort: "Kaohsiung, TW", destinationPort: "Long Beach, CA", etd: day(-161), eta: day(-142), sailedOnBoardDate: day(-160) },
    { shipmentNumber: "SHP-1003", billOfLading: "EGLV1420067", containerNumber: "EGHU9034112", carrier: "Evergreen", vessel: "EVER LOTUS", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Long Beach, CA", etd: day(-131), eta: day(-112), sailedOnBoardDate: day(-130) },
    { shipmentNumber: "SHP-1004", billOfLading: "COSU6633540", containerNumber: "CSNU5321776", carrier: "COSCO", vessel: "COSCO PACIFIC", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Los Angeles, CA", etd: day(-101), eta: day(-82), sailedOnBoardDate: day(-100) },
    { shipmentNumber: "SHP-1005", billOfLading: "YMLU4471933", containerNumber: "YMLU8812004", carrier: "Yang Ming", vessel: "YM WELLNESS", mode: "ocean", originPort: "Kaohsiung, TW", destinationPort: "Oakland, CA", etd: day(-76), eta: day(-57), sailedOnBoardDate: day(-75) },
    { shipmentNumber: "SHP-1006", billOfLading: "HLCU2288411", containerNumber: "HLXU6120458", carrier: "Hapag-Lloyd", vessel: "DALIAN EXPRESS", mode: "ocean", originPort: "Haiphong, VN", destinationPort: "Seattle, WA", etd: day(-46), eta: day(-27), sailedOnBoardDate: null },
    { shipmentNumber: "SHP-1007", billOfLading: "297-44815630", containerNumber: null, carrier: "China Airlines Cargo", vessel: null, mode: "air", originPort: "Taipei (TPE)", destinationPort: "Los Angeles (LAX)", etd: day(-15), eta: day(-14), sailedOnBoardDate: day(-15) },
    { shipmentNumber: "SHP-1008", billOfLading: "ONEY9902218", containerNumber: "ONEU7745102", carrier: "Ocean Network Express", vessel: "ONE HAMBURG", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Long Beach, CA", etd: day(-14), eta: day(4), sailedOnBoardDate: day(-13) },
    // Carries the stacked-findings entry's batteries; sailed well before
    // the Section 122 cutoff, so only the reciprocal/301 stack applies.
    { shipmentNumber: "SHP-1009", billOfLading: "MSCU7781245", containerNumber: "MSDU5540911", carrier: "MSC", vessel: "MSC ARIA", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Long Beach, CA", etd: day(-37), eta: day(-19), sailedOnBoardDate: day(-36) },
  ];

  // -------------------------------------------------------------- entries
  //
  // 8 entries over ~6 months, all dated before the Section 122 cutoff of
  // day(-10) so no seeded entry owes the surcharge. Header totals are the
  // sums of the DECLARED charge rows — consistent with lines by
  // construction; the planted findings are declared-vs-official
  // discrepancies, which the auditor derives from reference data.

  type LineSpec = {
    lineNumber: number;
    sku: string;
    quantity: number;
    unitValue?: number; // defaults to primary-source cost; overrides drift
    /** Declared line supplier; defaults to the primary source's vendor. */
    supplier?: string;
    /** Declared COO; defaults to the primary source's origin. Charges are
     *  always built from THIS declared value — a supplier/COO mismatch is
     *  the coo_discrepancy rule's job, not the money rules'. */
    coo?: string;
    /** Declared HTS; defaults to the part's catalog code. Charges are built
     *  from THIS declared value — a mismatch is the hts_discrepancy rule's
     *  job, and the money rules skip a line with classification doubt. */
    declaredHts?: string;
    /** A line whose SKU is NOT in the catalog: every declared fact is spelled
     *  out here and the part lookup is skipped (part_id lands null, so no
     *  catalog rule can fire). The analysis-defect entries use this. */
    custom?: {
      description: string;
      htsCode: string;
      coo: string;
      supplier: string;
      unitValue: number;
    };
    mutate?: (charges: ChargeSeed[], enteredValue: number) => void;
  };

  const entrySpecs: {
    entryNumber: string;
    entryDate: string;
    portOfEntry: string;
    /** 7501 entry type; defaults to "01" (03 = AD/CVD). */
    entryType?: string;
    totalRefund: number | null;
    hmf: boolean; // false = air entry, no harbor maintenance fee
    lines: LineSpec[];
  }[] = [
    {
      entryNumber: "231-4501287-4", entryDate: day(-170), portOfEntry: "Los Angeles, CA (2704)", totalRefund: 1120.0, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-MTR-750W", quantity: 100 },
        { lineNumber: 2, sku: "EB-BAT-48V", quantity: 80 },
      ],
    },
    {
      entryNumber: "231-4501293-1", entryDate: day(-140), portOfEntry: "Long Beach, CA (2709)", totalRefund: 661.5, hmf: true,
      lines: [
        // THE planted reclassification finding: filed under 8531.80.9051
        // (1.3%), the catalog code of its day — see CLASSIFICATION_WINDOWS.
        // Charges are consistent under the declared code, so only
        // hts_reclassified fires (recoverable base duty under today's Free
        // code).
        { lineNumber: 1, sku: "EB-DSP-LCD", quantity: 200, declaredHts: "8531.80.9051" },
        { lineNumber: 2, sku: "EB-BRK-HYD", quantity: 150, unitValue: 66.2 },
        { lineNumber: 3, sku: "EB-MTR-500W", quantity: 120 },
      ],
    },
    {
      entryNumber: "231-4501305-2", entryDate: day(-110), portOfEntry: "Long Beach, CA (2709)", totalRefund: null, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-CTRL-V2", quantity: 300 },
        { lineNumber: 2, sku: "EB-BAT-52V", quantity: 60 },
      ],
    },
    // THE planted entry — three findings for the auditor:
    {
      entryNumber: "231-4501311-9", entryDate: day(-80), portOfEntry: "Los Angeles, CA (2704)", totalRefund: null, hmf: true,
      lines: [
        {
          // rate_mismatch: Section 301 List 1 declared at 20%, official 25%.
          lineNumber: 1, sku: "EB-MTR-750W", quantity: 120,
          mutate: (charges, enteredValue) => {
            const c = charges.find((ch) => ch.htsCode === "9903.88.01");
            if (!c) throw new Error("plant failed: 9903.88.01 not present");
            c.rate = 0.2;
            c.amount = round2(0.2 * enteredValue);
          },
        },
        {
          // missing_measure: Section 301 List 3 expected, no charge row.
          lineNumber: 2, sku: "EB-BAT-48V", quantity: 100,
          mutate: (charges) => {
            const i = charges.findIndex((ch) => ch.htsCode === "9903.88.03");
            if (i < 0) throw new Error("plant failed: 9903.88.03 not present");
            charges.splice(i, 1);
          },
        },
        {
          // $0 exclusion claim: 9903.88.67 declared at $0 in place of List
          // 3 — a statement, never an underpayment.
          lineNumber: 3, sku: "EB-BAT-52V", quantity: 40,
          mutate: (charges) => {
            const c = charges.find((ch) => ch.htsCode === "9903.88.03");
            if (!c) throw new Error("plant failed: 9903.88.03 not present");
            c.htsCode = "9903.88.67";
            c.rate = 0;
            c.amount = 0;
          },
        },
      ],
    },
    // The planted classification finding: EB-BRK-HYD filed under the
    // dutiable "parts of brakes" code while the catalog says the free
    // brakes code. Charges match the declared code (10% base paid), so
    // only hts_discrepancy fires — and the base duty may be recoverable.
    {
      entryNumber: "231-4501320-0", entryDate: day(-55), portOfEntry: "Oakland, CA (2811)", totalRefund: null, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-BRK-HYD", quantity: 250, declaredHts: "8714.94.9000" },
        { lineNumber: 2, sku: "EB-FRM-MTB", quantity: 130 },
      ],
    },
    {
      entryNumber: "231-4501334-6", entryDate: day(-25), portOfEntry: "Seattle, WA (3001)", totalRefund: null, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-WHL-27F", quantity: 180, unitValue: 39.2 },
        { lineNumber: 2, sku: "EB-SDL-CMF", quantity: 400 },
      ],
    },
    // Air entry: MPF declared, no HMF — MPF/HMF are ingested facts.
    {
      entryNumber: "231-4501341-1", entryDate: day(-12), portOfEntry: "Los Angeles, CA (2704)", totalRefund: null, hmf: false,
      lines: [
        { lineNumber: 1, sku: "EB-DSP-LCD", quantity: 250, unitValue: 29.4 },
        // THE planted sourcing finding: declared origin CN under the Hanoi
        // vendor, whose catalog source for this controller is VN. Charges
        // match the declared CN (301 paid), so only coo_discrepancy fires —
        // and the 301 duty may be refundable if VN is the true origin.
        { lineNumber: 2, sku: "EB-CTRL-V2", quantity: 150, unitValue: 43.1, supplier: HANOI, coo: "CN" },
      ],
    },
    // THE stacked-findings entry: one line, every coexisting issue class.
    // The broker keyed the 7501 from a stale revision of INV-2026-207 —
    // 60 of the 65 invoiced batteries entered (quantity + per-SKU value vs
    // the CI, gated open by the header-value failure), base duty fat-
    // fingered at 6.5% instead of the official 3.4% (rate + amount pair,
    // overpaid), and the 10% IEEPA reciprocal dropped entirely
    // (missing_measure, underpaid). The CI meanwhile prints subheading
    // 8507.80 and origin VN against the declared 8507.60.0020/CN
    // (invoice_hts_mismatch + CI coo_discrepancy). The declared HTS matches
    // the catalog ON PURPOSE: an hts_discrepancy would suspend the money
    // rules, and the CI's printed code is deliberately weaker evidence.
    {
      entryNumber: "231-4501347-8", entryDate: day(-18), portOfEntry: "Long Beach, CA (2709)", totalRefund: null, hmf: true,
      lines: [
        {
          lineNumber: 1, sku: "EB-BAT-52V", quantity: 60,
          mutate: (charges, enteredValue) => {
            const base = charges.find((ch) => ch.chargeType === "base_duty");
            if (!base) throw new Error("plant failed: base duty not present");
            base.rate = 0.065;
            base.amount = round2(0.065 * enteredValue);
            const i = charges.findIndex((ch) => ch.htsCode === "9903.01.25");
            if (i < 0) throw new Error("plant failed: 9903.01.25 not present");
            charges.splice(i, 1);
          },
        },
      ],
    },
    // --------------------------- analysis-defect entries (see header) ----
    // All three audit deterministically CLEAN — seed.ts asserts it. The
    // defects live where only the AI analyst looks: fee bounds, document
    // extracted_data, and the description-vs-code axis.
    //
    // MPF below the statutory minimum: the entry is small enough that the
    // uncapped ad valorem MPF ($2,940 × 0.3464% = $10.18) lands under the
    // per-entry minimum the broker should have applied. Every other seeded
    // entry's nominal MPF sits safely inside the [min, max] window.
    {
      entryNumber: "231-4501352-6", entryDate: day(-45), portOfEntry: "Los Angeles, CA (2704)", totalRefund: null, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-SDL-CMF", quantity: 300 },
      ],
    },
    // AD/CVD case-number discrepancy: type 03, an antidumping charge with NO
    // Chapter 99 code (the money rules skip codeless charges by design), and
    // case numbers that disagree between the 7501 document (A-570-121) and
    // the CI INV-2026-215 (A-570-133) — see the documents section.
    {
      entryNumber: "231-4501358-3", entryDate: day(-35), portOfEntry: "Long Beach, CA (2709)", entryType: "03", totalRefund: null, hmf: true,
      lines: [
        {
          lineNumber: 1, sku: "EB-BAT-48V", quantity: 90,
          mutate: (charges, enteredValue) => {
            charges.push({
              chargeType: "antidumping",
              htsCode: null,
              rate: 0.2547,
              amount: round2(0.2547 * enteredValue),
            });
          },
        },
      ],
    },
    // Description/HTS mismatch: line 2's declared description is plainly a
    // lithium battery, filed under the saddle code (301 List 3 at 7.5%
    // instead of the battery heading's 25%). Off-catalog SKU, so no catalog
    // rule can fire; charges are self-consistent under the declared code.
    {
      entryNumber: "231-4501364-1", entryDate: day(-28), portOfEntry: "Oakland, CA (2811)", totalRefund: null, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-CTRL-V2", quantity: 150 },
        {
          lineNumber: 2, sku: "EB-PWR-EXT", quantity: 45,
          custom: {
            description: "48V 10Ah Range-Extender Lithium Battery",
            htsCode: "8714.95.0000",
            coo: "CN",
            supplier: SHENZHEN,
            unitValue: 96.0,
          },
        },
      ],
    },
  ];

  const DUTY_TYPES = new Set<ChargeTypeValue>([
    "base_duty",
    "additional_duty",
    "antidumping",
    "countervailing",
  ]);

  const entries: EntrySeed[] = entrySpecs.map((es) => {
    const sums = { entered: 0, duty: 0, base: 0, mpf: 0, hmf: 0 }; // cents
    const lines: EntryLineSeed[] = es.lines.map((ls) => {
      let unitValue: number;
      let declaredCoo: string;
      let declaredHts: string;
      let supplierName: string;
      let description: string;
      if (ls.custom) {
        // Off-catalog line: declared facts only, no part behind it.
        unitValue = ls.custom.unitValue;
        declaredCoo = ls.custom.coo;
        declaredHts = ls.custom.htsCode;
        supplierName = ls.custom.supplier;
        description = ls.custom.description;
      } else {
        const p = part(ls.sku);
        if (!p.htsCode) throw new Error(`entry line SKU ${ls.sku} has no HTS code`);
        const source = primary(p);
        unitValue = ls.unitValue ?? Number(source.unitCost);
        declaredCoo = ls.coo ?? source.countryOfOrigin;
        declaredHts = ls.declaredHts ?? p.htsCode;
        supplierName = ls.supplier ?? source.vendor;
        description = p.name;
      }
      const enteredValue = round2(ls.quantity * unitValue);
      const charges = declaredCharges(declaredHts, declaredCoo, enteredValue, { hmf: es.hmf });
      ls.mutate?.(charges, enteredValue);

      sums.entered += Math.round(enteredValue * 100);
      for (const c of charges) {
        const cents = Math.round(c.amount * 100);
        if (c.chargeType === "base_duty") sums.base += cents;
        if (DUTY_TYPES.has(c.chargeType)) sums.duty += cents;
        else if (c.chargeType === "mpf") sums.mpf += cents;
        else if (c.chargeType === "hmf") sums.hmf += cents;
      }

      return {
        lineNumber: ls.lineNumber,
        sku: ls.sku,
        description,
        htsCode: declaredHts,
        countryOfOrigin: declaredCoo,
        supplierName,
        quantity: ls.quantity,
        unitValue,
        enteredValue,
        charges,
      };
    });

    return {
      entryNumber: es.entryNumber,
      entryDate: es.entryDate,
      portOfEntry: es.portOfEntry,
      entryType: es.entryType ?? "01",
      totalRefund: es.totalRefund,
      lines,
      totals: {
        enteredValue: sums.entered / 100,
        duty: sums.duty / 100,
        baseDuty: sums.base / 100,
        mpf: sums.mpf / 100,
        hmf: es.hmf ? sums.hmf / 100 : null,
      },
    };
  });

  // ------------------------------------------------------- link matrix
  //
  // PO-2026-003 spans SHP-1002/SHP-1003 (and entries 2/3) so cross-links
  // are exercised. SHP-1008 carries PO-2026-009 but has NO entry — the
  // future-entry projection's subject. PO-2026-010 has no links at all —
  // ordered, awaiting shipment.
  const E = (n: number) => entrySpecs[n - 1].entryNumber;
  const S = (n: number) => `SHP-100${n}`;
  const P = (n: number) => `PO-2026-0${String(n).padStart(2, "0")}`;

  const entryShipmentLinks: [string, string][] = [
    [E(1), S(1)], [E(2), S(2)], [E(3), S(3)], [E(4), S(4)],
    [E(5), S(5)], [E(6), S(6)], [E(7), S(7)], [E(8), S(9)],
  ];
  const entryPoLinks: [string, string][] = [
    [E(1), P(1)], [E(2), P(2)], [E(2), P(3)], [E(3), P(3)], [E(4), P(4)],
    [E(5), P(5)], [E(5), P(6)], [E(6), P(7)], [E(7), P(8)], [E(8), P(11)],
  ];
  const shipmentPoLinks: [string, string][] = [
    [S(1), P(1)], [S(2), P(2)], [S(2), P(3)], [S(3), P(3)], [S(4), P(4)],
    [S(5), P(5)], [S(5), P(6)], [S(6), P(7)], [S(7), P(8)], [S(8), P(9)],
    [S(9), P(11)],
  ];

  // ---------------------------------------------------- commercial invoices
  //
  // The CI is the primary document an entry is checked against for variance
  // (see audit/invoice-rules.ts). Six invoices, each directly linked to
  // exactly one entry, with five planted CI-vs-entry findings:
  //   INV-2026-081 → entry 1: CLEAN — the "audits clean" assertion holds.
  //   INV-2026-143 → entry 2: EB-DSP-LCD printed with origin CN (entry
  //     declares TW) → coo_discrepancy per SKU; EB-MTR-500W absent from the
  //     CI → invoice_sku_missing, and the coverage gate keeps the header
  //     value check silent.
  //   INV-2026-114 → entry 3: EB-CTRL-V2 printed under 6-digit HS 8504.90
  //     (entry declares 8504.40.9550 — subheading differs) →
  //     invoice_hts_mismatch (warning). Values match, so nothing else.
  //   INV-2026-198 → entry 6: EB-WHL-27F billed at 6,556.00 vs 7,056.00
  //     entered → header 10,476 vs 10,976 (error) → value_mismatch:
  //     invoice_total, gating value_mismatch:invoice_sku:EB-WHL-27F —
  //     over-declared value, duty recoverable.
  //   INV-8613 → entry 7: the packet CI (see the entry-packet documents
  //     below) — clean; it mirrors the declared facts, including the CN
  //     origin the catalog rule already flags.
  //   INV-2026-207 → entry 8: the stacked-line plant — bills 65 batteries
  //     (entry entered 60) under HS 8507.80 with origin VN, so the header
  //     value check fails (under-declared, error), gating the per-SKU
  //     value alert, plus quantity, CI-HTS, and CI-origin findings.
  const invoices: InvoiceSeed[] = [
    {
      invoiceNumber: "INV-2026-081", poNumber: P(1), supplierName: SHENZHEN,
      invoiceDate: day(-175), currency: "USD", totalAmount: 53910.0,
      incoterms: "FOB Yantian",
      lines: [
        { lineNumber: 1, sku: "EB-MTR-750W", description: "750W Mid-Drive Motor", htsCode: "8501.31.4000", countryOfOrigin: "CN", quantity: 100, unitPrice: 289.5 },
        { lineNumber: 2, sku: "EB-BAT-48V", description: "48V 14Ah Lithium Battery Pack", htsCode: "8507.60.0020", countryOfOrigin: "CN", quantity: 80, unitPrice: 312.0 },
      ],
    },
    {
      invoiceNumber: "INV-2026-143", poNumber: P(2), supplierName: TAICHUNG,
      invoiceDate: day(-143), currency: "USD", totalAmount: 15710.0,
      incoterms: "FOB Kaohsiung",
      lines: [
        // The CI prints the code of its day (pre-reclassification) — same
        // as the entry declares, so no HTS finding. Origin CN is the plant.
        { lineNumber: 1, sku: "EB-DSP-LCD", description: "Backlit LCD Display Unit", htsCode: "8531.80.9051", countryOfOrigin: "CN", quantity: 200, unitPrice: 28.9 },
        { lineNumber: 2, sku: "EB-BRK-HYD", description: "Hydraulic Disc Brake Set", htsCode: "8714.94.3080", countryOfOrigin: "TW", quantity: 150, unitPrice: 66.2 },
        // EB-MTR-500W (entry line 3) deliberately absent — the coverage gap.
      ],
    },
    {
      invoiceNumber: "INV-2026-114", poNumber: P(3), supplierName: SHENZHEN,
      invoiceDate: day(-114), currency: "USD", totalAmount: 38415.0,
      incoterms: "FOB Yantian",
      lines: [
        // 6-digit HS from a different subheading — the HTS plant.
        { lineNumber: 1, sku: "EB-CTRL-V2", description: "Sine-Wave Motor Controller V2", htsCode: "8504.90", countryOfOrigin: "CN", quantity: 300, unitPrice: 42.3 },
        { lineNumber: 2, sku: "EB-BAT-52V", description: "52V 20Ah Lithium Battery Pack", htsCode: "8507.60.0020", countryOfOrigin: "CN", quantity: 60, unitPrice: 428.75 },
      ],
    },
    {
      invoiceNumber: "INV-2026-198", poNumber: P(7), supplierName: HANOI,
      invoiceDate: day(-27), currency: "USD", totalAmount: 10476.0,
      incoterms: "FOB Haiphong",
      lines: [
        // Billed $500 under the entered value — the value plant. The header
        // total matches the line sum, so the CI is internally consistent.
        { lineNumber: 1, sku: "EB-WHL-27F", description: '27.5" Front Wheel, Thru-Axle', htsCode: "8714.92.1000", countryOfOrigin: "VN", quantity: 180, unitPrice: 36.42, totalPrice: 6556.0 },
        { lineNumber: 2, sku: "EB-SDL-CMF", description: "Comfort Gel Saddle", htsCode: "8714.95.0000", countryOfOrigin: "CN", quantity: 400, unitPrice: 9.8 },
      ],
    },
    {
      invoiceNumber: "INV-2026-207", poNumber: P(11), supplierName: SHENZHEN,
      invoiceDate: day(-20), currency: "USD", totalAmount: 27868.75,
      incoterms: "FOB Yantian",
      lines: [
        // 65 billed vs 60 entered; a 6-digit HS from the wrong subheading
        // ("other storage batteries"); origin printed VN against the
        // declared CN. Header total = line sum, so the CI is internally
        // consistent and stays money-eligible.
        { lineNumber: 1, sku: "EB-BAT-52V", description: "52V 20Ah Lithium Battery Pack", htsCode: "8507.80", countryOfOrigin: "VN", quantity: 65, unitPrice: 428.75 },
      ],
    },
    {
      invoiceNumber: "INV-8613", poNumber: P(8), supplierName: TAICHUNG,
      invoiceDate: day(-13), currency: "USD", totalAmount: 13815.0,
      incoterms: "FOB Taipei",
      lines: [
        { lineNumber: 1, sku: "EB-DSP-LCD", description: "Backlit LCD Display Unit", htsCode: "8531.20.0040", countryOfOrigin: "TW", quantity: 250, unitPrice: 29.4 },
        // Mirrors the DECLARED origin (CN) — the declared-vs-catalog origin
        // finding belongs to the catalog rule, not the CI comparison.
        { lineNumber: 2, sku: "EB-CTRL-V2", description: "Sine-Wave Motor Controller V2", htsCode: "8504.40.9550", countryOfOrigin: "CN", quantity: 150, unitPrice: 43.1 },
      ],
    },
    // The AD/CVD entry's CI: mirrors every declared fact (so the CI-vs-entry
    // rules stay quiet) but prints case A-570-133 against the 7501's
    // A-570-121 — the discrepancy lives only in the document corpus. The
    // supplier's own order ref stands in for a PO we never ingested.
    {
      invoiceNumber: "INV-2026-215", poNumber: "SVD-SO-8841", supplierName: SHENZHEN,
      invoiceDate: day(-37), currency: "USD", totalAmount: 28080.0,
      incoterms: "FOB Yantian",
      lines: [
        { lineNumber: 1, sku: "EB-BAT-48V", description: "48V 14Ah Lithium Battery Pack", htsCode: "8507.60.0020", countryOfOrigin: "CN", quantity: 90, unitPrice: 312.0, adcvdCaseNumber: "A-570-133" },
      ],
    },
    // The description/HTS entry's CI: mirrors the declared facts — including
    // the battery description printed against the saddle code, corroborating
    // what the entry line already says.
    {
      invoiceNumber: "INV-2026-221", poNumber: "SVD-SO-8907", supplierName: SHENZHEN,
      invoiceDate: day(-30), currency: "USD", totalAmount: 10665.0,
      incoterms: "FOB Yantian",
      lines: [
        { lineNumber: 1, sku: "EB-CTRL-V2", description: "Sine-Wave Motor Controller V2", htsCode: "8504.40.9550", countryOfOrigin: "CN", quantity: 150, unitPrice: 42.3 },
        { lineNumber: 2, sku: "EB-PWR-EXT", description: "48V 10Ah Range-Extender Lithium Battery", htsCode: "8714.95.0000", countryOfOrigin: "CN", quantity: 45, unitPrice: 96.0 },
      ],
    },
  ];

  const entryInvoiceLinks: [string, string][] = [
    [E(1), "INV-2026-081"],
    [E(2), "INV-2026-143"],
    [E(3), "INV-2026-114"],
    [E(6), "INV-2026-198"],
    [E(7), "INV-8613"],
    [E(8), "INV-2026-207"],
    [E(10), "INV-2026-215"],
    [E(11), "INV-2026-221"],
  ];

  // -------------------------------------------------------------- refunds
  //
  // RC1 paid out; RC2 accepted but not yet transmitted (pending payout).
  // Status strings read like ACE ES-022 output. entries.totalRefund above
  // is kept in sync (1120.00 = 1050 + 70; 661.50 = 640 + 21.50).
  const refundClaims: RefundClaimSeed[] = [
    {
      key: "RC1",
      entryNumber: E(1),
      claimType: "LIQUIDATION REFUND",
      claimStatus: "CAPE ACCEPTED",
      refundStatus: "TRANSMITTED TO TREASURY",
      refundNumber: "R-84172",
      refundClassAmount: "1050.00",
      refundInterestAmount: "70.00",
      entryDate: day(-170),
      liquidationDate: day(-95),
      refundDate: day(-30),
    },
    {
      key: "RC2",
      entryNumber: E(2),
      claimType: "LIQUIDATION REFUND",
      claimStatus: "CAPE ACCEPTED",
      refundStatus: "AUTHORIZED",
      refundNumber: null,
      refundClassAmount: "640.00",
      refundInterestAmount: "21.50",
      entryDate: day(-140),
      liquidationDate: day(-42),
      refundDate: null,
    },
  ];

  // -------------------------------------------------------------- quotes
  const quoteSheets: QuoteSheetSeed[] = [
    // Received, unapproved — a rival supplier undercutting EB-MTR-500W's
    // current cost. "Quote received" on the part is derived, not stored.
    {
      key: "QS1",
      supplierName: "Ningbo E-Drive Systems",
      quoteDate: day(-4),
      validUntil: day(26),
      notes: null,
      documentFile: "quote-ningbo-edrive.pdf",
      lines: [
        { lineNumber: 1, sku: "EB-MTR-500W", partCreated: false, description: "500W geared hub motor, 36-hole", unitCost: "139.0000", countryOfOrigin: "CN", htsCode: "8501.31.4000", moq: "100.0000", leadTimeDays: 35, status: "received", decidedBy: null, decidedAt: null, decisionNote: null, appliedAt: null, appliedPoLineRef: null },
      ],
    },
    // Approved, awaiting its PO — makes EB-SDL-CMF "pending changes"
    // (derived). PO-2026-010 (open, day(-3)) is the matching order.
    {
      key: "QS2",
      supplierName: HANGZHOU,
      quoteDate: day(-9),
      validUntil: day(51),
      notes: "Manual entry from supplier email.",
      documentFile: null,
      lines: [
        { lineNumber: 1, sku: "EB-SDL-CMF", partCreated: false, description: "Comfort gel saddle, steel rails", unitCost: "9.1500", countryOfOrigin: "CN", htsCode: null, moq: "500.0000", leadTimeDays: 28, status: "approved", decidedBy: "Alex", decidedAt: at(-6, 15, 20), decisionNote: "6.6% below current cost, same spec — approved pending first PO.", appliedAt: null, appliedPoLineRef: null },
      ],
    },
    // Applied historical — its PO line (PO-2026-005 #1) arrived on
    // SHP-1005 and made 64.80 the official cost.
    {
      key: "QS3",
      supplierName: TAICHUNG,
      quoteDate: day(-92),
      validUntil: null,
      notes: null,
      documentFile: null,
      lines: [
        { lineNumber: 1, sku: "EB-BRK-HYD", partCreated: false, description: "Hydraulic disc brake set, 180mm rotors", unitCost: "64.8000", countryOfOrigin: "TW", htsCode: "8714.94.3080", moq: "200.0000", leadTimeDays: 30, status: "applied", decidedBy: "Alex", decidedAt: at(-88, 11, 0), decisionNote: "Renegotiated 2026 pricing.", appliedAt: at(-45, 9, 30), appliedPoLineRef: { poNumber: "PO-2026-005", lineNumber: 1 } },
      ],
    },
    // Rejected — Hanoi's VN motor was $2 over Shenzhen's cost, so it went
    // to the archive. Under stacked China duties it lands cheaper: the seed
    // runs the quote re-analysis against the Section 301 window and this is
    // the SKU that opens a reconsider item (the demo of that alert).
    {
      key: "QS5",
      supplierName: HANOI,
      quoteDate: day(-30),
      validUntil: day(60),
      notes: null,
      documentFile: null,
      lines: [
        { lineNumber: 1, sku: "EB-MTR-500W", partCreated: false, description: "500W geared hub motor, 36-hole", unitCost: "150.0000", countryOfOrigin: "VN", htsCode: null, moq: "100.0000", leadTimeDays: 40, status: "rejected", decidedBy: "Alex", decidedAt: at(-28, 10, 0), decisionNote: "$2 above Shenzhen's cost, same spec.", appliedAt: null, appliedPoLineRef: null },
      ],
    },
    // Received quote for an unknown SKU — created draft part EB-CHG-52V
    // (partCreated=true is the provenance).
    {
      key: "QS4",
      supplierName: SHENZHEN,
      quoteDate: day(-2),
      validUntil: day(28),
      notes: null,
      documentFile: "quote-svd-chargers.pdf",
      lines: [
        { lineNumber: 1, sku: "EB-CHG-52V", partCreated: true, description: "52V 4A fast charger, GX16 plug", unitCost: "21.7500", countryOfOrigin: "CN", htsCode: "8504.40.9550", moq: "200.0000", leadTimeDays: 25, status: "received", decidedBy: null, decidedAt: null, decisionNote: null, appliedAt: null, appliedPoLineRef: null },
      ],
    },
  ];

  // -------------------------------------------------- integration sources
  const integrationSources: SourceSeed[] = [
    { kind: "manual_upload", name: "Manual upload", status: "active", config: {}, lastReceivedAt: at(-3, 15, 0), lastRunAt: null },
    { kind: "sftp", name: "Broker document feed", status: "active", config: { host: "sftp.pacificbrokerage.example.com", folder: "/outbound/waystar", filePattern: "*.pdf" }, lastReceivedAt: at(-2, 6, 30), lastRunAt: hoursAgo(2) },
    { kind: "email_inbox", name: "Document inbox", status: "active", config: { address: ORG_SEED.inboxAddress }, lastReceivedAt: at(-1, 16, 0), lastRunAt: null },
  ];

  // ------------------------------------------------------------ org rules
  //
  // One enabled guidance rule (prompt-only, perturbs nothing) and one
  // DISABLED suppression rule showing the full UI shape. The suppression
  // rule must stay disabled: the seeded audit pass asserts specific entries
  // audit clean and the analysis-defect entries stay rule-invisible — an
  // active suppression would perturb both.
  const orgRules: RuleSeed[] = [
    {
      text: "Always check type 03 entries for AD/CVD case number consistency.",
      suppression: null,
      enabled: true,
      source: "manual",
      createdByName: ORG_SEED.defaultActorName,
    },
    {
      text: "Ignore invoice comparison skips for non-USD invoices.",
      suppression: {
        alertTypes: ["invoice_comparison_skipped"],
        supplierName: null,
        countryOfOrigin: null,
        htsPrefix: null,
      },
      enabled: false,
      source: "manual",
      createdByName: ORG_SEED.defaultActorName,
    },
  ];

  // ------------------------------------------------------------ documents
  //
  // One per major artifact. uploadedAt is 1–2 days AFTER the business date
  // so the events feed can show occurred ≠ recorded. 7501s and POs arrive
  // by manual upload, BOLs via the broker SFTP feed, and QS4's quote sheet
  // through the org inbox.
  const sh = (n: number) => shipments[n - 1];
  const en = (n: number) => entries[n - 1];

  const entryDoc = (
    n: number,
    upload: Date,
    bols: string[],
    pos: string[],
    shipNos: number[],
    // Extra 7501 fields (spread LAST so it can override, e.g. entry_type
    // "03" plus adcvd_case_numbers on the AD/CVD entry).
    extra: Record<string, unknown> = {},
  ): DocumentSeed => ({
    fileName: `entry-${en(n).entryNumber}.pdf`,
    docType: "port_entry",
    sourceKind: "manual_upload",
    uploadedAt: upload,
    extractedData: {
      entry_number: en(n).entryNumber,
      entry_date: en(n).entryDate,
      port_of_entry: en(n).portOfEntry,
      entry_type: "01",
      importer_of_record: ORG_SEED.importerOfRecord,
      referenced_bols: bols,
      referenced_pos: pos,
      ...extra,
    },
    links: [
      { entityType: "entry", key: en(n).entryNumber, created: true },
      ...shipNos.map((s): DocLinkSeed => ({ entityType: "shipment", key: S(s), created: false })),
      ...pos.map((p): DocLinkSeed => ({ entityType: "purchase_order", key: p, created: false })),
    ],
  });

  const bolDoc = (n: number, upload: Date, pos: string[]): DocumentSeed => ({
    fileName: `bol-${sh(n).billOfLading.replace(/\W/g, "")}.pdf`,
    docType: "shipment",
    sourceKind: "sftp",
    uploadedAt: upload,
    extractedData: {
      bill_of_lading: sh(n).billOfLading,
      container_number: sh(n).containerNumber,
      carrier: sh(n).carrier,
      vessel: sh(n).vessel,
      origin_port: sh(n).originPort,
      destination_port: sh(n).destinationPort,
      etd: sh(n).etd,
      eta: sh(n).eta,
      // SHP-1006's BOL carries no on-board notation — the ETD-fallback demo.
      ...(sh(n).sailedOnBoardDate
        ? { sailed_on_board_date: sh(n).sailedOnBoardDate }
        : {}),
      referenced_pos: pos,
    },
    links: [
      { entityType: "shipment", key: S(n), created: true },
      ...pos.map((p): DocLinkSeed => ({ entityType: "purchase_order", key: p, created: false })),
    ],
  });

  const poDoc = (n: number, upload: Date): DocumentSeed => {
    const po = purchaseOrders[n - 1];
    return {
      fileName: `${po.poNumber.toLowerCase()}.pdf`,
      docType: "purchase_order",
      sourceKind: "manual_upload",
      uploadedAt: upload,
      extractedData: {
        po_number: po.poNumber,
        supplier_name: po.supplierName,
        order_date: po.orderDate,
        currency: "USD",
        total_amount: po.totalAmount,
        line_items: po.lines.map((l) => ({
          sku: l.sku,
          country_of_origin: l.countryOfOrigin ?? null,
          quantity: l.quantity,
          unit_price: l.unitPrice,
        })),
      },
      links: [{ entityType: "purchase_order", key: po.poNumber, created: true }],
    };
  };

  // The CI document behind an InvoiceSeed — extractedData mirrors
  // CommercialInvoiceExtraction (including per-line hts_code).
  const invByNumber = new Map(invoices.map((i) => [i.invoiceNumber, i]));
  const ciExtraction = (invoiceNumber: string) => {
    const inv = invByNumber.get(invoiceNumber);
    if (!inv) throw new Error(`story references unknown invoice ${invoiceNumber}`);
    return {
      invoice_number: inv.invoiceNumber,
      po_number: inv.poNumber,
      supplier_name: inv.supplierName,
      invoice_date: inv.invoiceDate,
      currency: inv.currency,
      amount: inv.totalAmount,
      incoterms: inv.incoterms,
      line_items: inv.lines.map((l) => ({
        line_number: l.lineNumber,
        sku: l.sku,
        description: l.description,
        country_of_origin: l.countryOfOrigin,
        hts_code: l.htsCode,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        total_price: l.totalPrice ?? round2(l.quantity * l.unitPrice),
        // Document-only fact: no invoice column carries case numbers.
        ...(l.adcvdCaseNumber ? { adcvd_case_number: l.adcvdCaseNumber } : {}),
      })),
    };
  };

  const ciDoc = (
    invoiceNumber: string,
    entryNumber: string,
    poNumber: string,
    upload: Date,
  ): DocumentSeed => ({
    fileName: `invoice-${invoiceNumber.toLowerCase()}.pdf`,
    docType: "commercial_invoice",
    sourceKind: "email_inbox",
    uploadedAt: upload,
    extractedData: ciExtraction(invoiceNumber),
    links: [
      { entityType: "invoice", key: invoiceNumber, created: true },
      { entityType: "entry", key: entryNumber, created: false },
      { entityType: "purchase_order", key: poNumber, created: false },
    ],
  });

  // ------------------------------------------------- the entry packet
  //
  // Entry 7's 7501 arrives the real-world way: inside ONE broker packet PDF
  // bundling the 7501 (pp. 1–2), the commercial invoice (pp. 3–4), the
  // packing list (p. 5), and an assist sheet (p. 6). The parent's
  // extracted_data is the split manifest; the children are ordinary
  // documents sharing the parent's file, page-scoped. The assist sheet
  // lands as "other" — columnar like an invoice, but never one.
  const packetFile = `entry-packet-${en(7).entryNumber}.pdf`;
  const packetChild = (
    role: PacketRoleValue,
    label: string,
    pageRange: number[],
    docType: DocumentTypeValue,
    extractedData: unknown,
    links: DocLinkSeed[],
  ): DocumentSeed => ({
    fileName: `entry-packet-${en(7).entryNumber} — ${label} (${pageRange.length > 1 ? `pp. ${pageRange[0]}–${pageRange[pageRange.length - 1]}` : `p. ${pageRange[0]}`}).pdf`,
    docType,
    sourceKind: "sftp",
    uploadedAt: at(-11, 9, 5),
    extractedData,
    links,
    packet: { parentFileName: packetFile, role, pageRange },
  });

  const packetDocuments: DocumentSeed[] = [
    {
      fileName: packetFile,
      docType: "entry_packet",
      sourceKind: "sftp",
      uploadedAt: at(-11, 9, 0),
      pages: 6,
      extractedData: {
        parts: [
          { part_index: 1, role: "entry_summary_7501", doc_type: "port_entry", title: "Entry Summary 7501", pages: [1, 2], confidence: "high" },
          { part_index: 2, role: "commercial_invoice", doc_type: "commercial_invoice", title: "Commercial Invoice", pages: [3, 4], confidence: "high" },
          { part_index: 3, role: "packing_list", doc_type: "packing_list", title: "Packing List", pages: [5], confidence: "high" },
          { part_index: 4, role: "assist_sheet", doc_type: "other", title: "Assist Sheet", pages: [6], confidence: "low" },
        ],
      },
      links: [],
    },
    packetChild(
      "entry_summary_7501", "Entry summary (7501)", [1, 2], "port_entry",
      {
        entry_number: en(7).entryNumber,
        entry_date: en(7).entryDate,
        port_of_entry: en(7).portOfEntry,
        entry_type: "01",
        importer_of_record: ORG_SEED.importerOfRecord,
        referenced_bols: ["297-44815630"],
        referenced_pos: [P(8)],
        referenced_invoices: ["INV-8613"],
      },
      [
        { entityType: "entry", key: en(7).entryNumber, created: true },
        { entityType: "shipment", key: S(7), created: false },
        { entityType: "purchase_order", key: P(8), created: false },
        { entityType: "invoice", key: "INV-8613", created: false },
      ],
    ),
    packetChild(
      "commercial_invoice", "Commercial invoice", [3, 4], "commercial_invoice",
      ciExtraction("INV-8613"),
      [
        { entityType: "invoice", key: "INV-8613", created: true },
        { entityType: "entry", key: en(7).entryNumber, created: false },
        { entityType: "purchase_order", key: P(8), created: false },
      ],
    ),
    packetChild(
      "packing_list", "Packing list", [5], "packing_list",
      {
        bill_of_lading: "297-44815630",
        cartons: 42,
        gross_weight_kg: 1265,
        referenced_pos: [P(8)],
      },
      [{ entityType: "shipment", key: S(7), created: false }],
    ),
    packetChild(
      "assist_sheet", "Assist sheet", [6], "other",
      {
        note: "Assist sheet — statutory additions to customs value. Not a commercial invoice; no fields extracted.",
      },
      [],
    ),
  ];

  const documents: DocumentSeed[] = [
    // 7501s — one per entry, uploaded 1–2 days after the entry date. Entry
    // 7's arrives inside the entry packet below instead.
    entryDoc(1, at(-169, 10, 0), ["MAEU2264101"], [P(1)], [1]),
    entryDoc(2, at(-139, 10, 0), ["ONEY8811327"], [P(2), P(3)], [2]),
    entryDoc(3, at(-108, 9, 30), ["EGLV1420067"], [P(3)], [3]),
    entryDoc(4, at(-78, 10, 0), ["COSU6633540"], [P(4)], [4]),
    entryDoc(5, at(-54, 11, 0), ["YMLU4471933"], [P(5), P(6)], [5]),
    entryDoc(6, at(-23, 10, 15), ["HLCU2288411"], [P(7)], [6]),
    entryDoc(8, at(-17, 10, 0), ["MSCU7781245"], [P(11)], [9]),
    // The analysis-defect entries' 7501s (no BOL/PO paper trail ingested).
    // Entry 10's carries the type-03 override and the 7501-side case number
    // that disagrees with its CI.
    entryDoc(9, at(-44, 10, 0), [], [], []),
    entryDoc(10, at(-34, 10, 0), [], [], [], {
      entry_type: "03",
      adcvd_case_numbers: ["A-570-121"],
    }),
    entryDoc(11, at(-27, 10, 0), [], [], []),
    ...packetDocuments,
    // Standalone commercial invoices — via the document inbox, a day or two
    // after their invoice dates.
    ciDoc("INV-2026-081", E(1), P(1), at(-173, 16, 0)),
    ciDoc("INV-2026-143", E(2), P(2), at(-141, 16, 0)),
    ciDoc("INV-2026-114", E(3), P(3), at(-112, 16, 0)),
    ciDoc("INV-2026-198", E(6), P(7), at(-26, 16, 0)),
    ciDoc("INV-2026-207", E(8), P(11), at(-19, 16, 0)),
    // The analysis-defect CIs reference supplier order numbers we never
    // ingested as POs — invoice + entry links only.
    {
      fileName: "invoice-inv-2026-215.pdf",
      docType: "commercial_invoice",
      sourceKind: "email_inbox",
      uploadedAt: at(-36, 16, 0),
      extractedData: ciExtraction("INV-2026-215"),
      links: [
        { entityType: "invoice", key: "INV-2026-215", created: true },
        { entityType: "entry", key: E(10), created: false },
      ],
    },
    {
      fileName: "invoice-inv-2026-221.pdf",
      docType: "commercial_invoice",
      sourceKind: "email_inbox",
      uploadedAt: at(-29, 16, 0),
      extractedData: ciExtraction("INV-2026-221"),
      links: [
        { entityType: "invoice", key: "INV-2026-221", created: true },
        { entityType: "entry", key: E(11), created: false },
      ],
    },
    // BOLs — via the broker SFTP feed, shortly after sailing.
    bolDoc(1, at(-189, 8, 0), [P(1)]),
    bolDoc(2, at(-159, 8, 0), [P(2), P(3)]),
    bolDoc(3, at(-129, 8, 0), [P(3)]),
    bolDoc(4, at(-99, 8, 0), [P(4)]),
    bolDoc(5, at(-74, 8, 0), [P(5), P(6)]),
    bolDoc(6, at(-44, 8, 0), [P(7)]),
    bolDoc(7, at(-14, 12, 0), [P(8)]),
    bolDoc(8, at(-12, 8, 0), [P(9)]),
    bolDoc(9, at(-35, 8, 0), [P(11)]),
    // POs — a representative three.
    poDoc(1, at(-204, 14, 0)),
    poDoc(4, at(-114, 14, 0)),
    poDoc(9, at(-29, 14, 0)),
    // Quote sheets — QS1 uploaded manually, QS4 arrived at the org inbox.
    {
      fileName: "quote-ningbo-edrive.pdf",
      docType: "quote_sheet",
      sourceKind: "manual_upload",
      uploadedAt: at(-3, 15, 0),
      extractedData: {
        supplier_name: "Ningbo E-Drive Systems",
        quote_date: day(-4),
        currency: "USD",
        valid_until: day(26),
        line_items: [
          { sku: "EB-MTR-500W", unit_cost: 139.0, moq: 100, lead_time_days: 35 },
        ],
      },
      links: [
        { entityType: "quote_sheet", key: "QS1", created: true },
        { entityType: "part", key: "EB-MTR-500W", created: false },
      ],
    },
    {
      fileName: "quote-svd-chargers.pdf",
      docType: "quote_sheet",
      sourceKind: "email_inbox",
      uploadedAt: at(-1, 16, 0),
      extractedData: {
        supplier_name: SHENZHEN,
        quote_date: day(-2),
        currency: "USD",
        valid_until: day(28),
        line_items: [
          { sku: "EB-CHG-52V", unit_cost: 21.75, moq: 200, lead_time_days: 25, suggested_hts: "8504.40.9550" },
        ],
      },
      links: [
        { entityType: "quote_sheet", key: "QS4", created: true },
        // This document created the draft part.
        { entityType: "part", key: "EB-CHG-52V", created: true },
      ],
    },
    // ACE ES-022 refund report covering both claims.
    {
      fileName: "ace-refund-report-es022.pdf",
      docType: "refund_report",
      sourceKind: "manual_upload",
      uploadedAt: at(-28, 9, 0),
      extractedData: {
        report_date: day(-28),
        claims: [
          {
            entry_summary_number: E(1),
            claim_type: "LIQUIDATION REFUND",
            claim_status: "CAPE ACCEPTED",
            refund_status: "TRANSMITTED TO TREASURY",
            refund_number: "R-84172",
            refund_class_amount: 1050.0,
            refund_interest_amount: 70.0,
            liquidation_date: day(-95),
            refund_date: day(-30),
          },
          {
            entry_summary_number: E(2),
            claim_type: "LIQUIDATION REFUND",
            claim_status: "CAPE ACCEPTED",
            refund_status: "AUTHORIZED",
            refund_class_amount: 640.0,
            refund_interest_amount: 21.5,
            liquidation_date: day(-42),
          },
        ],
      },
      links: [
        { entityType: "refund_claim", key: "RC1", created: true },
        { entityType: "refund_claim", key: "RC2", created: true },
        { entityType: "entry", key: E(1), created: false },
        { entityType: "entry", key: E(2), created: false },
      ],
    },
  ];

  // ---------------------------------------- classification history
  //
  // EB-DSP-LCD was classified as "other visual signalling apparatus"
  // (8531.80.9051, 1.3%) until a day(-40) review moved it to the Free
  // indicator-panel code. Entry 231-4501293-1 (day(-140)) filed under the
  // OLD code — correct for its day, so the auditor raises
  // hts_reclassified (recoverable base duty), not a misfiling. Entry
  // 231-4501341-1 (day(-12)) files under the new code and stays clean.
  const classificationWindows: ClassificationWindowSeed[] = [
    {
      sku: "EB-DSP-LCD",
      htsCode: "8531.80.9051",
      validFrom: null,
      validTo: day(-41),
      source: "seed",
      actor: null,
      note: null,
      recordedAt: at(-195, 9),
    },
    {
      sku: "EB-DSP-LCD",
      htsCode: "8531.20.0040",
      validFrom: day(-40),
      validTo: null,
      source: "manual_edit",
      actor: ORG_SEED.defaultActorName,
      note: "CBP ruling review: backlit LCD display units classify as indicator panels (8531.20), not other signalling apparatus.",
      recordedAt: at(-40, 10),
    },
  ];

  return {
    org: ORG_SEED,
    parts: PART_SEED,
    classificationWindows,
    purchaseOrders,
    shipments,
    entries,
    entryShipmentLinks,
    entryPoLinks,
    shipmentPoLinks,
    invoices,
    entryInvoiceLinks,
    refundClaims,
    quoteSheets,
    integrationSources,
    orgRules,
    documents,
  };
}
