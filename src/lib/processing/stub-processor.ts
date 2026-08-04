import { PART_SEED } from "@/lib/db/seed-data/story";
import {
  buildSeedReferenceData,
  HMF_RATE,
  MPF_RATE,
  type DayFn,
} from "@/lib/db/seed-data/tariff";
import { computeExpectedCharges, normalizeHts } from "@/lib/duty/calculator";
import type {
  DocumentProcessor,
  EntryChargeExtraction,
  EntryLineItemExtraction,
  ExtractionResult,
  ProcessInput,
  ProcessOutput,
} from "./types";

// Simulates Reducto: deterministic per filename, with a realistic delay and
// an occasional first-attempt failure so the status lifecycle is visible.
// Reference numbers are chosen from pools that overlap the seed data — the
// same way a real entry summary lists BOLs and PO numbers that already
// exist in your system — so processing a document genuinely exercises the
// many-to-many linking.

const BOL_POOL = [
  "MAEU2264101",
  "ONEY8811327",
  "EGLV1420067",
  "COSU6633540",
  "YMLU4471933",
  "HLCU2288411",
  "ONEY9902218",
];
const PO_POOL = [
  "PO-2026-001",
  "PO-2026-002",
  "PO-2026-003",
  "PO-2026-004",
  "PO-2026-005",
  "PO-2026-006",
];
const CARRIERS: [string, string, string][] = [
  ["Maersk", "MAERSK ESSEX", "MSKU"],
  ["Ocean Network Express", "ONE HARBOUR", "ONEU"],
  ["Evergreen", "EVER LOTUS", "EGHU"],
  ["COSCO", "COSCO PACIFIC", "CSNU"],
];
const SUPPLIERS = [
  "Shenzhen Volt Dynamics Co.",
  "Taichung Cycle Works Ltd.",
  "Hanoi Precision Components JSC",
];
const PORTS: [string, string][] = [
  ["Yantian, CN", "Los Angeles, CA"],
  ["Kaohsiung, TW", "Long Beach, CA"],
  ["Haiphong, VN", "Oakland, CA"],
];
const ENTRY_PORTS = [
  "Los Angeles, CA (2704)",
  "Long Beach, CA (2709)",
  "Oakland, CA (2811)",
  "Seattle, WA (3001)",
];
const ENTRY_POOL = [
  "231-4501287-4",
  "231-4501293-1",
  "231-4501311-9",
  "231-4501320-0",
  "231-4501334-6",
];
const CLAIM_TYPES = ["LIQUIDATION REFUND", "PSC REFUND", "PEA REFUND"];

// Sibling codes sharing the first 6 digits, for the HTS-vs-catalog
// discrepancy case (downgrades to info severity in the auditor).
const SIBLING_HTS: Record<string, string> = {
  "8714.94.3080": "8714.94.9000",
  "8714.99.8000": "8714.99.9000",
  "8714.92.1000": "8714.92.5000",
  "8501.31.4000": "8501.31.5000",
  "8507.60.0020": "8507.60.0010",
};

// Only parts with a committed catalog HTS can back a fabricated 7501 line
// (the draft/codeless seed parts have no code to declare under).
const CATALOG_PARTS = PART_SEED.filter(
  (p): p is (typeof PART_SEED)[number] & { htsCode: string } =>
    p.htsCode !== null && p.status === "active",
);
// The one TW aluminum-alloy frame (8714.91.x) — the Section 232 aluminum /
// reciprocal stacking case needs it specifically.
const TW_FRAME =
  CATALOG_PARTS.find((p) => normalizeHts(p.htsCode).startsWith("871491")) ??
  CATALOG_PARTS[0];

// The seed anchors reference windows (incl. the Section 122 sail-tiled
// pair) to the day it runs; the stub mirrors that by anchoring to the day
// the document is processed. Rebuilt per call — it's a handful of map
// inserts, and a long-running server must not drift across midnight.
const DAY_MS = 86_400_000;
const day: DayFn = (offset) =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

const centsToDollars = (c: number) => Math.round(c) / 100;

// Deterministic 7501 lines built from real catalog parts. Charges start
// from the duty calculator's own expectations (so clean lines audit clean),
// then each line's (seed + index) % 5 class injects one discrepancy:
//   0 = Section 301 declared at 20% instead of the expected rate
//   1 = the expected Section 301 charge is omitted entirely
//   2 = a TW aluminum frame line declares the reciprocal tariff that the
//       232 stacking rule suppresses
//   3 = declared HTS is a same-first-6 sibling of the catalog code
//   4 = clean
function buildLineItems(
  seed: number,
  entryDate: string,
): EntryLineItemExtraction[] {
  const seedRef = buildSeedReferenceData(day);
  const lineCount = 3 + (seed % 3);
  const items: EntryLineItemExtraction[] = [];

  for (let i = 0; i < lineCount; i++) {
    const cls = (seed + i) % 5;
    const part =
      cls === 2 ? TW_FRAME : CATALOG_PARTS[(seed + i * 11) % CATALOG_PARTS.length];
    const declaredHts =
      cls === 3 ? (SIBLING_HTS[part.htsCode] ?? part.htsCode) : part.htsCode;

    const quantity = 20 + ((seed + i * 13) % 180);
    const unitValue = Number(part.unitCost);
    const enteredValue = Math.round(quantity * unitValue * 100) / 100;
    const enteredCents = Math.round(enteredValue * 100);

    const expected = computeExpectedCharges(
      {
        htsDigits: normalizeHts(declaredHts),
        countryOfOrigin: part.countryOfOrigin,
        enteredValueCents: enteredCents,
        entryDate,
      },
      seedRef,
    );

    const charges: EntryChargeExtraction[] = [];
    if (
      expected.baseDuty &&
      expected.baseDuty.rate !== null &&
      expected.baseDuty.amountCents !== null &&
      expected.baseDuty.amountCents > 0
    ) {
      charges.push({
        charge_type: "base_duty",
        hts_code: declaredHts,
        rate: expected.baseDuty.rate,
        amount: centsToDollars(expected.baseDuty.amountCents),
      });
    }
    for (const m of expected.measures) {
      charges.push({
        charge_type: "additional_duty",
        hts_code: m.ch99Code,
        rate: m.rate,
        amount: centsToDollars(m.amountCents),
      });
    }

    if (cls === 0) {
      const c = charges.find((ch) => ch.hts_code?.startsWith("9903.88"));
      if (c) {
        c.rate = 0.2;
        c.amount = centsToDollars(0.2 * enteredCents);
      }
    } else if (cls === 1) {
      const idx = charges.findIndex((ch) => ch.hts_code?.startsWith("9903.88"));
      if (idx >= 0) charges.splice(idx, 1);
    } else if (cls === 2) {
      charges.push({
        charge_type: "additional_duty",
        hts_code: "9903.01.25",
        rate: 0.1,
        amount: centsToDollars(0.1 * enteredCents),
      });
    }

    charges.push({
      charge_type: "mpf",
      hts_code: "499",
      rate: MPF_RATE,
      amount: centsToDollars(MPF_RATE * enteredCents),
    });
    charges.push({
      charge_type: "hmf",
      hts_code: "501",
      rate: HMF_RATE,
      amount: centsToDollars(HMF_RATE * enteredCents),
    });

    items.push({
      line_number: i + 1,
      sku: part.sku,
      description: part.name,
      hts_code: declaredHts,
      country_of_origin: part.countryOfOrigin,
      quantity,
      unit_value: unitValue,
      entered_value: enteredValue,
      charges,
    });
  }

  return items;
}

const DUTY_CHARGE_TYPES = new Set([
  "base_duty",
  "additional_duty",
  "antidumping",
  "countervailing",
]);

function sumCharges(
  items: EntryLineItemExtraction[],
  match: (c: EntryChargeExtraction) => boolean,
): number {
  let cents = 0;
  for (const li of items) {
    for (const c of li.charges) {
      if (match(c)) cents += Math.round(c.amount * 100);
    }
  }
  return centsToDollars(cents);
}

function sumEnteredValue(items: EntryLineItemExtraction[]): number {
  let cents = 0;
  for (const li of items) cents += Math.round(li.entered_value * 100);
  return centsToDollars(cents);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pick<T>(pool: readonly T[], seed: number, offset = 0): T {
  return pool[(seed + offset) % pool.length];
}

function pickSome<T>(pool: readonly T[], seed: number, n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const item = pool[(seed + i * 7) % pool.length];
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StubDocumentProcessor implements DocumentProcessor {
  async process(input: ProcessInput): Promise<ProcessOutput> {
    return { extraction: await this.extract(input), raw: null };
  }

  private async extract(input: ProcessInput): Promise<ExtractionResult> {
    const seed = hashString(input.fileName);
    await sleep(500 + (seed % 600));

    // ~1 in 8 files fails on the first attempt; a reprocess succeeds.
    if (input.attempt <= 1 && seed % 8 === 0) {
      throw new Error(
        `Unable to detect table structure on page ${1 + (seed % 3)} of "${input.fileName}".`,
      );
    }

    const iso = (daysAgo: number) => day(-daysAgo);

    switch (input.docTypeHint) {
      case "port_entry": {
        // Prefer an entry number embedded in the filename (e.g.
        // entry-231-4501334-6.pdf) so uploads attach to existing records.
        const fromName = input.fileName.match(/\d{3}-\d{7}-\d/)?.[0];
        const entryDate = iso(seed % 20);
        const lineItems = buildLineItems(seed, entryDate);
        return {
          docType: "port_entry",
          fields: {
            entry_number:
              fromName ??
              `231-45${String(10000 + (seed % 89999)).padStart(5, "0")}-${seed % 10}`,
            entry_date: entryDate,
            port_of_entry: pick(ENTRY_PORTS, seed),
            entry_type: "01",
            importer_of_record: "Waystar Royco, Inc.",
            referenced_bols: pickSome(BOL_POOL, seed, 1 + (seed % 2)),
            referenced_pos: pickSome(PO_POOL, seed, 1 + (seed % 2)),
            // Header totals derived from the generated lines so the
            // auditor's trust gate reconciles.
            total_entered_value: sumEnteredValue(lineItems),
            total_duty: sumCharges(lineItems, (c) =>
              DUTY_CHARGE_TYPES.has(c.charge_type),
            ),
            mpf_amount: sumCharges(lineItems, (c) => c.charge_type === "mpf"),
            hmf_amount: sumCharges(lineItems, (c) => c.charge_type === "hmf"),
            line_items: lineItems,
          },
        };
      }
      case "refund_report": {
        const fromName = input.fileName.match(/\d{3}-\d{7}-\d/)?.[0];
        const claimCount = 1 + (seed % 3);
        const claims = [];
        for (let i = 0; i < claimCount; i++) {
          const cls = (seed + i) % 4;
          const classAmount =
            cls === 3 ? 0 : Math.round((400 + ((seed + i * 97) % 4600)) * 100) / 100;
          claims.push({
            entry_summary_number:
              i === 0 && fromName ? fromName : pick(ENTRY_POOL, seed, i * 3),
            claim_type: pick(CLAIM_TYPES, seed, i),
            claim_status: cls === 3 ? "REJECTED" : "CAPE ACCEPTED",
            refund_status: cls === 0 ? "TRANSMITTED TO TREASURY" : null,
            refund_number: `R-${80000 + ((seed + i * 31) % 19999)}`,
            refund_class_amount: classAmount,
            refund_interest_amount: Math.round(classAmount * 6) / 100,
            entry_date: iso(90 + (seed % 60)),
            liquidation_date: iso(40 + (seed % 30)),
            refund_date: cls === 0 ? iso(seed % 20) : null,
          });
        }
        return {
          docType: "refund_report",
          fields: { report_date: iso(0), claims },
        };
      }
      case "shipment": {
        const fromName = input.fileName.match(/[A-Z]{4}\d{7,10}/)?.[0];
        const bol = fromName ?? pick(BOL_POOL, seed);
        const [carrier, vessel, prefix] = pick(CARRIERS, seed);
        const [origin, destination] = pick(PORTS, seed);
        return {
          docType: "shipment",
          fields: {
            bill_of_lading: bol,
            container_number: `${prefix}${String(1000000 + (seed % 8999999))}`,
            carrier,
            vessel,
            origin_port: origin,
            destination_port: destination,
            etd: iso(14 + (seed % 10)),
            eta: iso(seed % 7),
            // On board the day after ETD, like a real BOL notation.
            shipped_on_board_date: iso(13 + (seed % 10)),
            referenced_pos: pickSome(PO_POOL, seed, 1 + (seed % 2)),
          },
        };
      }
      case "purchase_order": {
        const fromName = input.fileName.match(/po[-_]?(\d{4})[-_]?(\d{3})/i);
        return {
          docType: "purchase_order",
          fields: {
            po_number: fromName
              ? `PO-${fromName[1]}-${fromName[2]}`
              : pick(PO_POOL, seed),
            supplier_name: pick(SUPPLIERS, seed),
            order_date: iso(20 + (seed % 30)),
            currency: "USD",
            total_amount: 10000 + (seed % 90000),
            line_items: [
              {
                line_number: 1,
                sku: "EB-MTR-750W",
                description: "750W Mid-Drive Motor",
                quantity: 50 + (seed % 150),
                unit_price: 289.5,
              },
              {
                line_number: 2,
                sku: "EB-BAT-48V",
                description: "48V 14Ah Lithium Battery Pack",
                quantity: 40 + (seed % 100),
                unit_price: 312.0,
              },
            ],
          },
        };
      }
      case "commercial_invoice": {
        // Lines built from real catalog parts so SKUs match. Header amount
        // normally equals the line sum; seed % 4 === 0 shifts it ~2% so the
        // invoice-total audit finding is exercised.
        const lineCount = 2 + (seed % 3);
        const lineItems = [];
        let sumCents = 0;
        for (let i = 0; i < lineCount; i++) {
          const part = CATALOG_PARTS[(seed + i * 7) % CATALOG_PARTS.length];
          const quantity = 10 + ((seed + i * 17) % 120);
          const unitPrice = Number(part.unitCost);
          const totalCents = Math.round(quantity * unitPrice * 100);
          sumCents += totalCents;
          lineItems.push({
            line_number: i + 1,
            sku: part.sku,
            description: part.name,
            quantity,
            unit_price: unitPrice,
            total_price: centsToDollars(totalCents),
          });
        }
        const headerCents =
          seed % 4 === 0 ? Math.round(sumCents * 1.02) : sumCents;
        return {
          docType: "commercial_invoice",
          fields: {
            invoice_number: `INV-${1000 + (seed % 9000)}`,
            po_number: pick(PO_POOL, seed),
            supplier_name: pick(SUPPLIERS, seed),
            invoice_date: iso(10 + (seed % 30)),
            currency: "USD",
            amount: centsToDollars(headerCents),
            incoterms: pick(["FOB Yantian", "FOB Kaohsiung", "CIF Los Angeles"], seed),
            line_items: lineItems,
          },
        };
      }
      case "quote_sheet": {
        // Two lines exercise the whole quote flow: a known catalog SKU
        // (EB-SDL-CMF, seeded) re-quoted a bit below its current cost, and
        // an unknown SKU whose ingestion auto-creates a draft part.
        const quoteDate = iso(seed % 10);
        const knownCostCents = 980 - (seed % 120); // $8.60–$9.80
        const unknownCostCents = 1600 + (seed % 300); // $16.00–$18.99
        return {
          docType: "quote_sheet",
          fields: {
            supplier_name: "Hangzhou Comfort Components",
            quote_date: quoteDate,
            currency: "USD",
            valid_until: day(30 + (seed % 60)),
            notes: "FOB Shanghai. Prices firm for the validity period.",
            line_items: [
              {
                line_number: 1,
                sku: "EB-SDL-CMF",
                description: "Comfort gel saddle, steel rails",
                unit_cost: centsToDollars(knownCostCents),
                currency: null,
                country_of_origin: "CN",
                // The supplier's claimed HTS — display/estimate input only.
                hts_code: "8714.95.0000",
                moq: 500,
                lead_time_days: 21 + (seed % 15),
                unit_of_measure: "EA",
              },
              {
                line_number: 2,
                sku: "EB-RCK-ALU",
                description: "Aluminum rear cargo rack",
                unit_cost: centsToDollars(unknownCostCents),
                currency: null,
                country_of_origin: "CN",
                hts_code: "8714.99.8000",
                moq: 200,
                lead_time_days: 30,
                unit_of_measure: "EA",
              },
            ],
          },
        };
      }
      case "packing_list":
        return {
          docType: "packing_list",
          fields: {
            bill_of_lading: pick(BOL_POOL, seed),
            cartons: 50 + (seed % 500),
            gross_weight_kg: 1000 + (seed % 9000),
            referenced_pos: pickSome(PO_POOL, seed, 1),
          },
        };
      default:
        return {
          docType: "other",
          fields: {
            note: "Document type could not be classified; no fields extracted.",
          },
        };
    }
  }
}
