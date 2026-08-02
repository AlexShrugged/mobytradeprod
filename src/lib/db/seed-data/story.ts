// The demo story: one e-bike importer's last ~6 months of import activity,
// every date anchored to seed day via the day()/at() helpers so the demo
// never goes stale. All values are fixed literals or fixed formulas — no
// randomness anywhere.
//
// Derived data is NEVER seeded: no audit_alerts (the auditor computes
// them), no review_items/hts_classifications (the classification service
// lands later — parts carry only the projection column), no "pending
// changes" flags (derived from quote_lines on read).
//
// Planted audit findings (surfaced by the auditor, seeded as declared
// facts here) all live on entry 231-4501311-9:
//   line 1 — Section 301 List 1 declared at 20% instead of the official 25%
//   line 2 — Section 301 List 3 charge missing entirely
//   line 3 — a $0 exclusion claim (9903.88.67) in place of List 3 — a
//            statement, not an underpayment; must never be flagged

import type {
  ChargeTypeValue,
  DocumentTypeValue,
  EntryStatus,
  IntegrationKind,
  IntegrationStatusValue,
  PartHtsReviewStatusValue,
  PartStatus,
  PoStatus,
  QuoteLineStatus,
  ShipmentStatus,
} from "../schema";
import { normalizeHts } from "../../duty/calculator";
import { HMF_RATE, HTS_SEED, MPF_RATE } from "./tariff";
import type { DayFn } from "./tariff";

/** Date `offset` days from seed day at a fixed UTC time. */
export type AtFn = (offset: number, hour: number, minute?: number) => Date;

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- org

export const ORG_SEED = {
  name: "Countless Industries",
  importerOfRecord: "Countless Industries, Inc.",
  inboxAddress: "docs@countless.mobytrade.app",
};

// ---------------------------------------------------------------- parts
//
// 12 parts: 9 plain active, plus EB-SDL-CMF (active; its approved quote
// awaiting a PO makes it "pending changes" — derived, never stored),
// EB-CHG-48V (active; HTS review projection "pending", queue rows land with
// the classification service), and EB-CHG-52V (draft; created by quote
// sheet QS4 for an unknown SKU — carries the quote's cost, not an official
// one).

export type PartSeed = {
  sku: string;
  name: string;
  manufacturer: string;
  htsCode: string | null;
  countryOfOrigin: string;
  unitCost: string;
  status: PartStatus;
  htsReviewStatus: PartHtsReviewStatusValue | null;
};

export const PART_SEED: PartSeed[] = [
  { sku: "EB-MTR-750W", name: "750W Mid-Drive Motor", manufacturer: "Shenzhen Volt Dynamics", htsCode: "8501.31.4000", countryOfOrigin: "CN", unitCost: "289.5000", status: "active", htsReviewStatus: null },
  { sku: "EB-MTR-500W", name: "500W Geared Hub Motor", manufacturer: "Shenzhen Volt Dynamics", htsCode: "8501.31.4000", countryOfOrigin: "CN", unitCost: "148.0000", status: "active", htsReviewStatus: null },
  { sku: "EB-BAT-48V", name: "48V 14Ah Lithium Battery Pack", manufacturer: "Shenzhen Volt Dynamics", htsCode: "8507.60.0020", countryOfOrigin: "CN", unitCost: "312.0000", status: "active", htsReviewStatus: null },
  { sku: "EB-BAT-52V", name: "52V 20Ah Lithium Battery Pack", manufacturer: "Shenzhen Volt Dynamics", htsCode: "8507.60.0020", countryOfOrigin: "CN", unitCost: "428.7500", status: "active", htsReviewStatus: null },
  { sku: "EB-CTRL-V2", name: "Sine-Wave Motor Controller V2", manufacturer: "Shenzhen Volt Dynamics", htsCode: "8504.40.9550", countryOfOrigin: "CN", unitCost: "42.3000", status: "active", htsReviewStatus: null },
  { sku: "EB-DSP-LCD", name: "Backlit LCD Display Unit", manufacturer: "Taichung Cycle Works", htsCode: "8531.20.0040", countryOfOrigin: "TW", unitCost: "28.9000", status: "active", htsReviewStatus: null },
  { sku: "EB-FRM-MTB", name: "Hardtail MTB Alloy Frame", manufacturer: "Taichung Cycle Works", htsCode: "8714.91.3000", countryOfOrigin: "TW", unitCost: "104.5000", status: "active", htsReviewStatus: null },
  { sku: "EB-BRK-HYD", name: "Hydraulic Disc Brake Set", manufacturer: "Taichung Cycle Works", htsCode: "8714.94.3080", countryOfOrigin: "TW", unitCost: "64.8000", status: "active", htsReviewStatus: null },
  { sku: "EB-WHL-27F", name: '27.5" Front Wheel, Thru-Axle', manufacturer: "Hanoi Precision Components", htsCode: "8714.92.1000", countryOfOrigin: "VN", unitCost: "38.6000", status: "active", htsReviewStatus: null },
  // Active, with an approved quote awaiting its PO (see QS2 / PO-2026-010).
  { sku: "EB-SDL-CMF", name: "Comfort Gel Saddle", manufacturer: "Hangzhou Comfort Components", htsCode: "8714.95.0000", countryOfOrigin: "CN", unitCost: "9.8000", status: "active", htsReviewStatus: null },
  // Codeless — HTS review projection only; classification rows land in a
  // later phase.
  { sku: "EB-CHG-48V", name: "48V 3A Battery Charger", manufacturer: "Shenzhen Volt Dynamics", htsCode: null, countryOfOrigin: "CN", unitCost: "18.5000", status: "active", htsReviewStatus: "pending" },
  // Draft — created by quote sheet QS4 for an unknown SKU; cost is the
  // quote's, not official.
  { sku: "EB-CHG-52V", name: "52V 4A Fast Charger", manufacturer: "Shenzhen Volt Dynamics", htsCode: null, countryOfOrigin: "CN", unitCost: "21.7500", status: "draft", htsReviewStatus: null },
];

const partBySku = new Map(PART_SEED.map((p) => [p.sku, p]));

function part(sku: string): PartSeed {
  const p = partBySku.get(sku);
  if (!p) throw new Error(`story references unknown SKU ${sku}`);
  return p;
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
  status: EntryStatus;
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
  status: ShipmentStatus;
};

export type PoLineSeed = {
  lineNumber: number;
  sku: string;
  quantity: number;
  unitPrice: number;
};

export type PoSeed = {
  poNumber: string;
  supplierName: string;
  orderDate: string;
  expectedDate: string;
  status: PoStatus;
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
  key: "QS1" | "QS2" | "QS3" | "QS4";
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

export type DocLinkSeed = {
  entityType:
    | "entry"
    | "shipment"
    | "purchase_order"
    | "quote_sheet"
    | "refund_claim"
    | "part";
  key: string; // entryNumber | shipmentNumber | poNumber | QS key | RC key | sku
  created: boolean;
};

export type DocumentSeed = {
  fileName: string;
  docType: DocumentTypeValue;
  sourceKind: "manual_upload" | "sftp" | "email_inbox";
  uploadedAt: Date;
  extractedData: unknown;
  links: DocLinkSeed[];
};

export type Story = {
  org: typeof ORG_SEED;
  parts: PartSeed[];
  purchaseOrders: PoSeed[];
  shipments: ShipmentSeed[];
  entries: EntrySeed[];
  entryShipmentLinks: [entryNumber: string, shipmentNumber: string][];
  entryPoLinks: [entryNumber: string, poNumber: string][];
  shipmentPoLinks: [shipmentNumber: string, poNumber: string][];
  refundClaims: RefundClaimSeed[];
  quoteSheets: QuoteSheetSeed[];
  integrationSources: SourceSeed[];
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
    { poNumber: "PO-2026-001", supplierName: "Shenzhen Volt Dynamics Co.", orderDate: day(-205), expectedDate: day(-172), status: "received", lines: [
      { lineNumber: 1, sku: "EB-MTR-750W", quantity: 100, unitPrice: 289.5 },
      { lineNumber: 2, sku: "EB-BAT-48V", quantity: 80, unitPrice: 312.0 },
    ], totalAmount: 53910.0 },
    { poNumber: "PO-2026-002", supplierName: "Taichung Cycle Works Ltd.", orderDate: day(-175), expectedDate: day(-142), status: "received", lines: [
      { lineNumber: 1, sku: "EB-DSP-LCD", quantity: 200, unitPrice: 28.9 },
      // Pre-quote price for EB-BRK-HYD (66.20); QS3's application later
      // set the official cost to 64.80 — per-SKU price history.
      { lineNumber: 2, sku: "EB-BRK-HYD", quantity: 150, unitPrice: 66.2 },
    ], totalAmount: 15710.0 },
    { poNumber: "PO-2026-003", supplierName: "Shenzhen Volt Dynamics Co.", orderDate: day(-172), expectedDate: day(-140), status: "received", lines: [
      { lineNumber: 1, sku: "EB-MTR-500W", quantity: 120, unitPrice: 148.0 },
      { lineNumber: 2, sku: "EB-CTRL-V2", quantity: 300, unitPrice: 42.3 },
      { lineNumber: 3, sku: "EB-BAT-52V", quantity: 60, unitPrice: 428.75 },
    ], totalAmount: 56175.0 },
    { poNumber: "PO-2026-004", supplierName: "Shenzhen Volt Dynamics Co.", orderDate: day(-115), expectedDate: day(-82), status: "received", lines: [
      { lineNumber: 1, sku: "EB-MTR-750W", quantity: 120, unitPrice: 289.5 },
      { lineNumber: 2, sku: "EB-BAT-48V", quantity: 100, unitPrice: 312.0 },
      { lineNumber: 3, sku: "EB-BAT-52V", quantity: 40, unitPrice: 428.75 },
    ], totalAmount: 83090.0 },
    { poNumber: "PO-2026-005", supplierName: "Taichung Cycle Works Ltd.", orderDate: day(-98), expectedDate: day(-58), status: "received", lines: [
      { lineNumber: 1, sku: "EB-BRK-HYD", quantity: 250, unitPrice: 64.8 },
    ], totalAmount: 16200.0 },
    { poNumber: "PO-2026-006", supplierName: "Taichung Cycle Works Ltd.", orderDate: day(-96), expectedDate: day(-58), status: "received", lines: [
      { lineNumber: 1, sku: "EB-FRM-MTB", quantity: 130, unitPrice: 104.5 },
    ], totalAmount: 13585.0 },
    { poNumber: "PO-2026-007", supplierName: "Hanoi Precision Components JSC", orderDate: day(-70), expectedDate: day(-28), status: "partially_received", lines: [
      { lineNumber: 1, sku: "EB-WHL-27F", quantity: 180, unitPrice: 39.2 },
      { lineNumber: 2, sku: "EB-SDL-CMF", quantity: 400, unitPrice: 9.8 },
    ], totalAmount: 10976.0 },
    { poNumber: "PO-2026-008", supplierName: "Taichung Cycle Works Ltd.", orderDate: day(-40), expectedDate: day(-13), status: "received", lines: [
      { lineNumber: 1, sku: "EB-DSP-LCD", quantity: 250, unitPrice: 29.4 },
      { lineNumber: 2, sku: "EB-CTRL-V2", quantity: 150, unitPrice: 43.1 },
    ], totalAmount: 13815.0 },
    { poNumber: "PO-2026-009", supplierName: "Shenzhen Volt Dynamics Co.", orderDate: day(-30), expectedDate: day(6), status: "open", lines: [
      { lineNumber: 1, sku: "EB-MTR-750W", quantity: 150, unitPrice: 289.5 },
      { lineNumber: 2, sku: "EB-BAT-48V", quantity: 120, unitPrice: 315.0 },
    ], totalAmount: 81225.0 },
    { poNumber: "PO-2026-010", supplierName: "Hangzhou Comfort Components", orderDate: day(-3), expectedDate: day(30), status: "open", lines: [
      { lineNumber: 1, sku: "EB-SDL-CMF", quantity: 500, unitPrice: 9.18 },
    ], totalAmount: 4590.0 },
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
    { shipmentNumber: "SHP-1001", billOfLading: "MAEU2264101", containerNumber: "MSKU4471820", carrier: "Maersk", vessel: "MAERSK ESSEX", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Los Angeles, CA", etd: day(-191), eta: day(-172), sailedOnBoardDate: day(-190), status: "delivered" },
    { shipmentNumber: "SHP-1002", billOfLading: "ONEY8811327", containerNumber: "ONEU2203945", carrier: "Ocean Network Express", vessel: "ONE HARBOUR", mode: "ocean", originPort: "Kaohsiung, TW", destinationPort: "Long Beach, CA", etd: day(-161), eta: day(-142), sailedOnBoardDate: day(-160), status: "delivered" },
    { shipmentNumber: "SHP-1003", billOfLading: "EGLV1420067", containerNumber: "EGHU9034112", carrier: "Evergreen", vessel: "EVER LOTUS", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Long Beach, CA", etd: day(-131), eta: day(-112), sailedOnBoardDate: day(-130), status: "delivered" },
    { shipmentNumber: "SHP-1004", billOfLading: "COSU6633540", containerNumber: "CSNU5321776", carrier: "COSCO", vessel: "COSCO PACIFIC", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Los Angeles, CA", etd: day(-101), eta: day(-82), sailedOnBoardDate: day(-100), status: "delivered" },
    { shipmentNumber: "SHP-1005", billOfLading: "YMLU4471933", containerNumber: "YMLU8812004", carrier: "Yang Ming", vessel: "YM WELLNESS", mode: "ocean", originPort: "Kaohsiung, TW", destinationPort: "Oakland, CA", etd: day(-76), eta: day(-57), sailedOnBoardDate: day(-75), status: "delivered" },
    { shipmentNumber: "SHP-1006", billOfLading: "HLCU2288411", containerNumber: "HLXU6120458", carrier: "Hapag-Lloyd", vessel: "DALIAN EXPRESS", mode: "ocean", originPort: "Haiphong, VN", destinationPort: "Seattle, WA", etd: day(-46), eta: day(-27), sailedOnBoardDate: null, status: "arrived" },
    { shipmentNumber: "SHP-1007", billOfLading: "297-44815630", containerNumber: null, carrier: "China Airlines Cargo", vessel: null, mode: "air", originPort: "Taipei (TPE)", destinationPort: "Los Angeles (LAX)", etd: day(-15), eta: day(-14), sailedOnBoardDate: day(-15), status: "arrived" },
    { shipmentNumber: "SHP-1008", billOfLading: "ONEY9902218", containerNumber: "ONEU7745102", carrier: "Ocean Network Express", vessel: "ONE HAMBURG", mode: "ocean", originPort: "Yantian, CN", destinationPort: "Long Beach, CA", etd: day(-14), eta: day(4), sailedOnBoardDate: day(-13), status: "in_transit" },
  ];

  // -------------------------------------------------------------- entries
  //
  // 7 entries over ~6 months, all dated before the Section 122 cutoff of
  // day(-10) so no seeded entry owes the surcharge. Header totals are the
  // sums of the DECLARED charge rows — consistent with lines by
  // construction; the planted findings are declared-vs-official
  // discrepancies, which the auditor derives from reference data.

  type LineSpec = {
    lineNumber: number;
    sku: string;
    quantity: number;
    unitValue?: number; // defaults to catalog cost; overrides model drift
    mutate?: (charges: ChargeSeed[], enteredValue: number) => void;
  };

  const entrySpecs: {
    entryNumber: string;
    entryDate: string;
    portOfEntry: string;
    status: EntryStatus;
    totalRefund: number | null;
    hmf: boolean; // false = air entry, no harbor maintenance fee
    lines: LineSpec[];
  }[] = [
    {
      entryNumber: "231-4501287-4", entryDate: day(-170), portOfEntry: "Los Angeles, CA (2704)", status: "liquidated", totalRefund: 1120.0, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-MTR-750W", quantity: 100 },
        { lineNumber: 2, sku: "EB-BAT-48V", quantity: 80 },
      ],
    },
    {
      entryNumber: "231-4501293-1", entryDate: day(-140), portOfEntry: "Long Beach, CA (2709)", status: "liquidated", totalRefund: 661.5, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-DSP-LCD", quantity: 200 },
        { lineNumber: 2, sku: "EB-BRK-HYD", quantity: 150, unitValue: 66.2 },
        { lineNumber: 3, sku: "EB-MTR-500W", quantity: 120 },
      ],
    },
    {
      entryNumber: "231-4501305-2", entryDate: day(-110), portOfEntry: "Long Beach, CA (2709)", status: "released", totalRefund: null, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-CTRL-V2", quantity: 300 },
        { lineNumber: 2, sku: "EB-BAT-52V", quantity: 60 },
      ],
    },
    // THE planted entry — three findings for the auditor:
    {
      entryNumber: "231-4501311-9", entryDate: day(-80), portOfEntry: "Los Angeles, CA (2704)", status: "released", totalRefund: null, hmf: true,
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
    {
      entryNumber: "231-4501320-0", entryDate: day(-55), portOfEntry: "Oakland, CA (2811)", status: "released", totalRefund: null, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-BRK-HYD", quantity: 250 },
        { lineNumber: 2, sku: "EB-FRM-MTB", quantity: 130 },
      ],
    },
    {
      entryNumber: "231-4501334-6", entryDate: day(-25), portOfEntry: "Seattle, WA (3001)", status: "filed", totalRefund: null, hmf: true,
      lines: [
        { lineNumber: 1, sku: "EB-WHL-27F", quantity: 180, unitValue: 39.2 },
        { lineNumber: 2, sku: "EB-SDL-CMF", quantity: 400 },
      ],
    },
    // Air entry: MPF declared, no HMF — MPF/HMF are ingested facts.
    {
      entryNumber: "231-4501341-1", entryDate: day(-12), portOfEntry: "Los Angeles, CA (2704)", status: "filed", totalRefund: null, hmf: false,
      lines: [
        { lineNumber: 1, sku: "EB-DSP-LCD", quantity: 250, unitValue: 29.4 },
        { lineNumber: 2, sku: "EB-CTRL-V2", quantity: 150, unitValue: 43.1 },
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
      const p = part(ls.sku);
      if (!p.htsCode) throw new Error(`entry line SKU ${ls.sku} has no HTS code`);
      const unitValue = ls.unitValue ?? Number(p.unitCost);
      const enteredValue = round2(ls.quantity * unitValue);
      const charges = declaredCharges(p.htsCode, p.countryOfOrigin, enteredValue, { hmf: es.hmf });
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
        description: p.name,
        htsCode: p.htsCode,
        countryOfOrigin: p.countryOfOrigin,
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
      entryType: "01",
      status: es.status,
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
    [E(5), S(5)], [E(6), S(6)], [E(7), S(7)],
  ];
  const entryPoLinks: [string, string][] = [
    [E(1), P(1)], [E(2), P(2)], [E(2), P(3)], [E(3), P(3)], [E(4), P(4)],
    [E(5), P(5)], [E(5), P(6)], [E(6), P(7)], [E(7), P(8)],
  ];
  const shipmentPoLinks: [string, string][] = [
    [S(1), P(1)], [S(2), P(2)], [S(2), P(3)], [S(3), P(3)], [S(4), P(4)],
    [S(5), P(5)], [S(5), P(6)], [S(6), P(7)], [S(7), P(8)], [S(8), P(9)],
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
      supplierName: "Hangzhou Comfort Components",
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
      supplierName: "Taichung Cycle Works Ltd.",
      quoteDate: day(-92),
      validUntil: null,
      notes: null,
      documentFile: null,
      lines: [
        { lineNumber: 1, sku: "EB-BRK-HYD", partCreated: false, description: "Hydraulic disc brake set, 180mm rotors", unitCost: "64.8000", countryOfOrigin: "TW", htsCode: "8714.94.3080", moq: "200.0000", leadTimeDays: 30, status: "applied", decidedBy: "Alex", decidedAt: at(-88, 11, 0), decisionNote: "Renegotiated 2026 pricing.", appliedAt: at(-45, 9, 30), appliedPoLineRef: { poNumber: "PO-2026-005", lineNumber: 1 } },
      ],
    },
    // Received quote for an unknown SKU — created draft part EB-CHG-52V
    // (partCreated=true is the provenance).
    {
      key: "QS4",
      supplierName: "Shenzhen Volt Dynamics Co.",
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
    { kind: "sftp", name: "Broker document feed", status: "active", config: { host: "sftp.pacificbrokerage.example.com", folder: "/outbound/countless", filePattern: "*.pdf" }, lastReceivedAt: at(-2, 6, 30), lastRunAt: hoursAgo(2) },
    { kind: "email_inbox", name: "Document inbox", status: "active", config: { address: ORG_SEED.inboxAddress }, lastReceivedAt: at(-1, 16, 0), lastRunAt: null },
    { kind: "erp", name: "Acumatica", status: "not_configured", config: { provider: "acumatica" }, lastReceivedAt: null, lastRunAt: null },
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
          quantity: l.quantity,
          unit_price: l.unitPrice,
        })),
      },
      links: [{ entityType: "purchase_order", key: po.poNumber, created: true }],
    };
  };

  const documents: DocumentSeed[] = [
    // 7501s — one per entry, uploaded 1–2 days after the entry date.
    entryDoc(1, at(-169, 10, 0), ["MAEU2264101"], [P(1)], [1]),
    entryDoc(2, at(-139, 10, 0), ["ONEY8811327"], [P(2), P(3)], [2]),
    entryDoc(3, at(-108, 9, 30), ["EGLV1420067"], [P(3)], [3]),
    entryDoc(4, at(-78, 10, 0), ["COSU6633540"], [P(4)], [4]),
    entryDoc(5, at(-54, 11, 0), ["YMLU4471933"], [P(5), P(6)], [5]),
    entryDoc(6, at(-23, 10, 15), ["HLCU2288411"], [P(7)], [6]),
    entryDoc(7, at(-11, 9, 0), ["297-44815630"], [P(8)], [7]),
    // BOLs — via the broker SFTP feed, shortly after sailing.
    bolDoc(1, at(-189, 8, 0), [P(1)]),
    bolDoc(2, at(-159, 8, 0), [P(2), P(3)]),
    bolDoc(3, at(-129, 8, 0), [P(3)]),
    bolDoc(4, at(-99, 8, 0), [P(4)]),
    bolDoc(5, at(-74, 8, 0), [P(5), P(6)]),
    bolDoc(6, at(-44, 8, 0), [P(7)]),
    bolDoc(7, at(-14, 12, 0), [P(8)]),
    bolDoc(8, at(-12, 8, 0), [P(9)]),
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
        supplier_name: "Shenzhen Volt Dynamics Co.",
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

  return {
    org: ORG_SEED,
    parts: PART_SEED,
    purchaseOrders,
    shipments,
    entries,
    entryShipmentLinks,
    entryPoLinks,
    shipmentPoLinks,
    refundClaims,
    quoteSheets,
    integrationSources,
    documents,
  };
}
