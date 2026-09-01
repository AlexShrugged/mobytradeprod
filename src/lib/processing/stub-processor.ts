import type { DbClient } from "@/lib/db";
import { computeExpectedCharges, normalizeHts } from "@/lib/duty/calculator";
import { HMF_RATE, MPF_RATE } from "@/lib/duty/fees";
import { loadReferenceData } from "@/lib/duty/reference";
import type { MeasureRef, ReferenceData } from "@/lib/duty/types";
import type {
  DocumentProcessor,
  EntryChargeExtraction,
  EntryLineItemExtraction,
  ExtractionResult,
  PacketPartExtraction,
  ProcessInput,
  ProcessOutput,
} from "./types";

// Simulates Reducto: deterministic per filename, with a realistic delay and
// an occasional first-attempt failure so the status lifecycle is visible.
// Every org-specific fact on a fabricated document — catalog parts, vendor
// names, existing shipment/PO/entry numbers, the importer of record, tariff
// rates — comes from the StubContext snapshot of the CURRENT database, the
// same way a real entry summary lists identifiers that already exist in
// your system. Uploads therefore link into whatever the org holds (seeded
// or user-created) and stay consistent after catalog edits and applied
// tariff revisions. The demo story lives in the seed alone, never here.

// Real-world shipping vocabulary (not org data): carrier, a vessel it
// operates, and its container-number prefix.
const CARRIERS: [string, string, string][] = [
  ["Maersk", "MAERSK ESSEX", "MSKU"],
  ["Ocean Network Express", "ONE HARBOUR", "ONEU"],
  ["Evergreen", "EVER LOTUS", "EGHU"],
  ["COSCO", "COSCO PACIFIC", "CSNU"],
];
// Real trade lanes into US ports, origin → destination.
const LANES: [string, string][] = [
  ["Yantian, CN", "Los Angeles, CA"],
  ["Kaohsiung, TW", "Long Beach, CA"],
  ["Haiphong, VN", "Oakland, CA"],
];
// Real CBP ports of entry with their port codes.
const ENTRY_PORTS = [
  "Los Angeles, CA (2704)",
  "Long Beach, CA (2709)",
  "Oakland, CA (2811)",
  "Seattle, WA (3001)",
];
// CBP ACE claim-type vocabulary.
const CLAIM_TYPES = ["LIQUIDATION REFUND", "PSC REFUND", "PEA REFUND"];

export type StubCatalogSource = {
  vendor: string;
  countryOfOrigin: string | null;
  unitCost: string | null;
};

export type StubCatalogPart = {
  sku: string;
  name: string;
  htsCode: string | null;
  status: string;
  sources: StubCatalogSource[];
};

// Snapshot of the org data the stub fabricates against. Produced by
// loadStubContext in the app; tests prime it straight from the seed modules.
export type StubContext = {
  importerOfRecord: string | null;
  parts: StubCatalogPart[];
  // Identifiers that already exist, so fabricated references genuinely
  // exercise the many-to-many linking.
  bolPool: string[];
  poPool: string[];
  entryPool: string[];
  reference: ReferenceData;
};

// A handful of small reads per processed document — cheap at demo scale,
// and it keeps a long-running server current with catalog edits and
// applied tariff revisions. Ordered by stable natural keys (not createdAt)
// so same-filename reprocesses stay deterministic.
export async function loadStubContext(db: DbClient): Promise<StubContext> {
  const [org, parts, shipments, pos, entries, reference] = await Promise.all([
    db.query.orgs.findFirst(),
    db.query.parts.findMany({
      with: {
        sources: {
          with: { vendor: true },
          // Fabricated documents reflect today's sourcing: current windows only.
          where: (s, { isNull }) => isNull(s.validTo),
          orderBy: (s, { asc }) => [asc(s.createdAt), asc(s.id)],
        },
      },
      orderBy: (p, { asc }) => [asc(p.sku)],
    }),
    db.query.shipments.findMany({
      columns: { billOfLading: true },
      orderBy: (s, { asc }) => [asc(s.shipmentNumber)],
    }),
    db.query.purchaseOrders.findMany({
      columns: { poNumber: true },
      orderBy: (p, { asc }) => [asc(p.poNumber)],
    }),
    db.query.entries.findMany({
      columns: { entryNumber: true },
      orderBy: (e, { asc }) => [asc(e.entryNumber)],
    }),
    loadReferenceData(db),
  ]);
  return {
    importerOfRecord: org?.importerOfRecord ?? org?.name ?? null,
    parts: parts.map((p) => ({
      sku: p.sku,
      name: p.name,
      htsCode: p.htsCode,
      status: p.status,
      sources: p.sources.map((s) => ({
        vendor: s.vendor.name,
        countryOfOrigin: s.countryOfOrigin,
        unitCost: s.unitCost,
      })),
    })),
    bolPool: shipments
      .map((s) => s.billOfLading)
      .filter((b): b is string => b !== null),
    poPool: pos.map((p) => p.poNumber),
    entryPool: entries.map((e) => e.entryNumber),
    reference,
  };
}

// Document dates anchor to the day of processing, mirroring the seed's
// relative-date convention — the demo never goes stale.
const DAY_MS = 86_400_000;
const day = (offset: number) =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

const centsToDollars = (c: number) => Math.round(c) / 100;

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

// The invoice number a packet's 7501 references and its CI carries — both
// derived from the same packet seed, so the pair agrees in either
// processing order.
function stubInvoiceNumber(packetSeed: number): string {
  return `INV-${7000 + (packetSeed % 2000)}`;
}

function pickSome<T>(pool: readonly T[], seed: number, n: number): T[] {
  if (pool.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const item = pool[(seed + i * 7) % pool.length];
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StubDocumentProcessor implements DocumentProcessor {
  // Only parts with a committed catalog HTS and a costed source can back a
  // fabricated 7501 line (draft/codeless parts have no code to declare
  // under). Cost, COO, and supplier come from the part's PRIMARY source
  // (sources[0]).
  private readonly catalog: (StubCatalogPart & { htsCode: string })[];
  // A TW aluminum-alloy frame (8714.91.x) when the catalog has one — the
  // Section 232 aluminum / reciprocal stacking case needs it specifically.
  private readonly twFrame: (StubCatalogPart & { htsCode: string }) | undefined;
  // A dual-sourced part — the COO-vs-catalog discrepancy case declares one
  // vendor's origin under the other vendor's name.
  private readonly dualSourced:
    | (StubCatalogPart & { htsCode: string })
    | undefined;
  // Distinct vendor names from the catalog's sources — canonical by
  // construction (vendor resolution is trim+casefold only, so any variant
  // spelling would mint a duplicate vendor row).
  private readonly suppliers: string[];

  constructor(private readonly ctx: StubContext) {
    this.catalog = ctx.parts.filter(
      (p): p is StubCatalogPart & { htsCode: string } =>
        p.htsCode !== null &&
        p.status === "active" &&
        p.sources[0]?.unitCost != null,
    );
    this.twFrame =
      this.catalog.find((p) => normalizeHts(p.htsCode).startsWith("871491")) ??
      this.catalog[0];
    this.dualSourced = this.catalog.find((p) => p.sources.length >= 2);
    this.suppliers = [
      ...new Set(this.catalog.flatMap((p) => p.sources.map((s) => s.vendor))),
    ];
  }

  async process(input: ProcessInput): Promise<ProcessOutput> {
    return { extraction: await this.extract(input), raw: null };
  }

  // Declared-vs-catalog sibling for the class-3 hts_discrepancy case: the
  // schedule's nearest same-first-6 product code. Falls back to the catalog
  // code itself (a clean line) when the schedule holds no sibling.
  private sibling(htsCode: string): string {
    const digits = normalizeHts(htsCode);
    const stem = digits.slice(0, 6);
    const candidates = [...this.ctx.reference.htsByDigits.values()]
      .filter(
        (h) =>
          h.chapter < 98 &&
          h.codeDigits !== digits &&
          h.codeDigits.startsWith(stem),
      )
      .sort((a, b) => a.codeDigits.localeCompare(b.codeDigits));
    return candidates[0]?.code ?? htsCode;
  }

  // The earliest reciprocal-authority measure, for the class-2 plant: a TW
  // aluminum frame line declares the reciprocal tariff that the 232
  // stacking rule suppresses. Resolved from reference data so an applied
  // rate revision keeps the declared charge in step with what the auditor
  // expects.
  private reciprocal(): MeasureRef | undefined {
    return this.ctx.reference.measures
      .filter((m) => m.authority === "reciprocal")
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
  }

  // Filer-code prefix ("XXX-XX") matching the org's existing entries, so
  // fabricated entry numbers look like they came from the same broker.
  private entryNumberPrefix(): string {
    return (this.ctx.entryPool[0] ?? "000-0000000-0").slice(0, 6);
  }

  private fabricateEntryNumber(seed: number, offset = 0): string {
    return `${this.entryNumberPrefix()}${String(
      10000 + ((seed + offset) % 89999),
    ).padStart(5, "0")}-${(seed + offset) % 10}`;
  }

  // Deterministic 7501 lines built from real catalog parts. Charges start
  // from the duty calculator's own expectations (so clean lines audit
  // clean), then each line's (seed + index) % 6 class injects one
  // discrepancy:
  //   0 = Section 301 declared at 80% of the expected rate
  //   1 = the expected Section 301 charge is omitted entirely
  //   2 = a TW aluminum frame line declares the reciprocal tariff that the
  //       232 stacking rule suppresses
  //   3 = declared HTS is a same-first-6 sibling of the catalog code
  //   4 = clean
  //   5 = a dual-sourced part declared under its SECOND vendor's name but
  //       with the primary source's origin — charges match the declared
  //       COO, so only the coo_discrepancy rule fires
  private buildLineItems(
    seed: number,
    entryDate: string,
  ): EntryLineItemExtraction[] {
    if (this.catalog.length === 0) return [];
    const twFrame = this.twFrame ?? this.catalog[0];
    const lineCount = 3 + (seed % 3);
    const items: EntryLineItemExtraction[] = [];

    for (let i = 0; i < lineCount; i++) {
      const cls = (seed + i) % 6;
      const part =
        cls === 2
          ? twFrame
          : cls === 5 && this.dualSourced
            ? this.dualSourced
            : this.catalog[(seed + i * 11) % this.catalog.length];
      const source = part.sources[0];
      const declaredHts = cls === 3 ? this.sibling(part.htsCode) : part.htsCode;
      // Class 5: the second vendor's name, the primary source's COO.
      const supplierName =
        cls === 5 && this.dualSourced && part.sources.length >= 2
          ? part.sources[1].vendor
          : source.vendor;

      const quantity = 20 + ((seed + i * 13) % 180);
      const unitValue = Number(source.unitCost);
      const enteredValue = Math.round(quantity * unitValue * 100) / 100;
      const enteredCents = Math.round(enteredValue * 100);

      const expected = computeExpectedCharges(
        {
          htsDigits: normalizeHts(declaredHts),
          countryOfOrigin: source.countryOfOrigin,
          enteredValueCents: enteredCents,
          entryDate,
        },
        this.ctx.reference,
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
        // The stub fabricates demo documents from the seed reference, which
        // is all ad-valorem; skip presence-only measures defensively.
        if (m.amountCents === null) continue;
        charges.push({
          charge_type: "additional_duty",
          hts_code: m.ch99Code,
          rate: m.rate,
          amount: centsToDollars(m.amountCents),
        });
      }

      if (cls === 0) {
        // Declared at 80% of the expected rate (e.g. 20% against an
        // expected 25%) so the rate_mismatch rule fires whatever the
        // current reference rate is.
        const c = charges.find((ch) => ch.hts_code?.startsWith("9903.88"));
        if (c && c.rate !== null) {
          c.rate = Math.round(c.rate * 0.8 * 10000) / 10000;
          c.amount = centsToDollars(c.rate * enteredCents);
        }
      } else if (cls === 1) {
        const idx = charges.findIndex((ch) =>
          ch.hts_code?.startsWith("9903.88"),
        );
        if (idx >= 0) charges.splice(idx, 1);
      } else if (cls === 2) {
        const reciprocal = this.reciprocal();
        if (reciprocal && reciprocal.rate !== null) {
          charges.push({
            charge_type: "additional_duty",
            hts_code: reciprocal.ch99Code,
            rate: reciprocal.rate,
            amount: centsToDollars(reciprocal.rate * enteredCents),
          });
        }
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
        country_of_origin: source.countryOfOrigin,
        supplier_name: supplierName,
        quantity,
        unit_value: unitValue,
        entered_value: enteredValue,
        charges,
      });
    }

    return items;
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
    const ctx = this.ctx;

    // Packet children all share the parent's storageKey, so facts derived
    // from THIS seed agree across siblings whatever order they process in:
    // the 7501 child's referenced invoice number equals the CI child's
    // invoice number, and both land on the same PO.
    const packetSeed = input.packetRole ? hashString(input.storageKey) : null;

    switch (input.docTypeHint) {
      case "port_entry": {
        // Prefer an entry number embedded in the filename (e.g.
        // entry-300-1234567-8.pdf) so uploads attach to existing records.
        const fromName = input.fileName.match(/\d{3}-\d{7}-\d/)?.[0];
        const entryDate = iso(seed % 20);
        const lineItems = this.buildLineItems(seed, entryDate);
        return {
          docType: "port_entry",
          fields: {
            entry_number: fromName ?? this.fabricateEntryNumber(seed),
            entry_date: entryDate,
            port_of_entry: pick(ENTRY_PORTS, seed),
            entry_type: "01",
            importer_of_record: ctx.importerOfRecord,
            referenced_bols: pickSome(ctx.bolPool, seed, 1 + (seed % 2)),
            referenced_pos:
              packetSeed !== null
                ? pickSome(ctx.poPool, packetSeed, 1)
                : pickSome(ctx.poPool, seed, 1 + (seed % 2)),
            referenced_invoices:
              packetSeed !== null ? [stubInvoiceNumber(packetSeed)] : [],
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
      case "cargo_release": {
        // Attach-only downstream: reference an existing entry/BOL when the
        // org has one so the link actually lands.
        const fromName = input.fileName.match(/\d{3}-\d{7}-\d/)?.[0];
        return {
          docType: "cargo_release",
          fields: {
            entry_number:
              fromName ??
              (ctx.entryPool.length
                ? pick(ctx.entryPool, seed)
                : this.fabricateEntryNumber(seed)),
            entry_date: iso(seed % 20),
            referenced_bols: pickSome(ctx.bolPool, seed, 1),
          },
        };
      }
      case "tariff_code_sheet": {
        // Attach-only downstream, like a release: reference an existing
        // entry when the org has one so the mapping actually lands, and
        // map catalog SKUs to low line numbers.
        const fromName = input.fileName.match(/\d{3}-\d{7}-\d/)?.[0];
        const rows = pickSome(
          ctx.parts,
          seed,
          Math.min(2 + (seed % 3), ctx.parts.length),
        ).map((part, i) => ({
          entry_line_number: 1 + (i % 2),
          part_number: part.sku,
          po_number: ctx.poPool.length ? pick(ctx.poPool, seed, i) : null,
          description: part.name ?? null,
        }));
        return {
          docType: "tariff_code_sheet",
          fields: {
            entry_number:
              fromName ??
              (ctx.entryPool.length
                ? pick(ctx.entryPool, seed)
                : this.fabricateEntryNumber(seed)),
            broker_ref: null,
            referenced_invoices:
              packetSeed !== null ? [stubInvoiceNumber(packetSeed)] : [],
            rows,
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
            cls === 3
              ? 0
              : Math.round((400 + ((seed + i * 97) % 4600)) * 100) / 100;
          claims.push({
            entry_summary_number:
              i === 0 && fromName
                ? fromName
                : ctx.entryPool.length
                  ? pick(ctx.entryPool, seed, i * 3)
                  : this.fabricateEntryNumber(seed, i * 3),
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
        const [carrier, vessel, prefix] = pick(CARRIERS, seed);
        const bol =
          fromName ??
          (ctx.bolPool.length
            ? pick(ctx.bolPool, seed)
            : `${prefix}${String(2000000 + (seed % 7999999))}`);
        const [origin, destination] = pick(LANES, seed);
        return {
          docType: "shipment",
          fields: {
            bill_of_lading: bol,
            container_number: `${prefix}${String(1000000 + (seed % 8999999))}`,
            carrier,
            vessel,
            // The stub's carriers/lanes are all ocean liners.
            mode: "ocean" as const,
            origin_port: origin,
            destination_port: destination,
            etd: iso(14 + (seed % 10)),
            eta: iso(seed % 7),
            // On board the day after ETD, like a real BOL notation.
            shipped_on_board_date: iso(13 + (seed % 10)),
            referenced_pos: pickSome(ctx.poPool, seed, 1 + (seed % 2)),
          },
        };
      }
      case "purchase_order": {
        const fromName = input.fileName.match(/po[-_]?(\d{4})[-_]?(\d{3})/i);
        // Catalog-backed lines so quote→PO matching and per-SKU history
        // land on real SKUs; the header total reconciles with the lines.
        const lineItems = [];
        let sumCents = 0;
        const lineCount = Math.min(2, this.catalog.length);
        for (let i = 0; i < lineCount; i++) {
          const part = this.catalog[(seed + i * 7) % this.catalog.length];
          const source = part.sources[0];
          const quantity = 40 + ((seed + i * 23) % 160);
          const unitPrice = Number(source.unitCost);
          sumCents += Math.round(quantity * unitPrice * 100);
          lineItems.push({
            line_number: i + 1,
            sku: part.sku,
            description: part.name,
            country_of_origin: source.countryOfOrigin,
            quantity,
            unit_price: unitPrice,
          });
        }
        return {
          docType: "purchase_order",
          fields: {
            po_number: fromName
              ? `PO-${fromName[1]}-${fromName[2]}`
              : ctx.poPool.length
                ? pick(ctx.poPool, seed)
                : `PO-${1000 + (seed % 9000)}`,
            supplier_name: this.suppliers.length
              ? pick(this.suppliers, seed)
              : null,
            order_date: iso(20 + (seed % 30)),
            currency: "USD",
            total_amount: centsToDollars(sumCents),
            line_items: lineItems,
          },
        };
      }
      case "commercial_invoice": {
        // Lines built from real catalog parts so SKUs match. Header amount
        // normally equals the line sum; seed % 4 === 0 shifts it ~2% so the
        // invoice-total audit finding is exercised, and seed % 4 === 2
        // credits a prior-year rebate below the goods subtotal — the
        // amount payable drops, the goods value (and the audit) do not.
        const lineCount = Math.min(2 + (seed % 3), this.catalog.length);
        const lineItems = [];
        let sumCents = 0;
        for (let i = 0; i < lineCount; i++) {
          const part = this.catalog[(seed + i * 7) % this.catalog.length];
          const source = part.sources[0];
          const quantity = 10 + ((seed + i * 17) % 120);
          const unitPrice = Number(source.unitCost);
          const totalCents = Math.round(quantity * unitPrice * 100);
          sumCents += totalCents;
          lineItems.push({
            line_number: i + 1,
            sku: part.sku,
            description: part.name,
            country_of_origin: source.countryOfOrigin,
            // The catalog part's own code — packet CIs audit clean against
            // entries built from the same catalog.
            hts_code: part.htsCode,
            quantity,
            unit_price: unitPrice,
            total_price: centsToDollars(totalCents),
          });
        }
        const rebateCents = seed % 4 === 2 ? Math.round(sumCents * 0.05) : 0;
        const headerCents =
          seed % 4 === 0 ? Math.round(sumCents * 1.02) : sumCents - rebateCents;
        const [origin] = pick(LANES, seed);
        return {
          docType: "commercial_invoice",
          fields: {
            invoice_number:
              packetSeed !== null
                ? stubInvoiceNumber(packetSeed)
                : `INV-${1000 + (seed % 9000)}`,
            po_number:
              packetSeed !== null
                ? (pickSome(ctx.poPool, packetSeed, 1)[0] ?? null)
                : ctx.poPool.length
                  ? pick(ctx.poPool, seed)
                  : null,
            supplier_name: this.suppliers.length
              ? pick(this.suppliers, seed)
              : null,
            invoice_date: iso(10 + (seed % 30)),
            currency: "USD",
            amount: centsToDollars(headerCents),
            subtotal: rebateCents > 0 ? centsToDollars(sumCents) : null,
            adjustments:
              rebateCents > 0
                ? [
                    {
                      label: "LESS PRIOR-YEAR REBATE",
                      amount: -centsToDollars(rebateCents),
                    },
                  ]
                : [],
            incoterms: `FOB ${origin.split(",")[0]}`,
            line_items: lineItems,
          },
        };
      }
      case "quote_sheet": {
        // Two lines exercise the whole quote flow: a catalog part re-quoted
        // by its own primary vendor a bit below the current cost, and one
        // SKU that is deliberately NOT a catalog part, whose ingestion
        // auto-creates a draft part. The unknown SKU is fabricated by
        // design — the draft-creation path needs a SKU the org does not
        // carry (if a user has since created it, the line degrades into an
        // ordinary re-quote, which is fine).
        const quoteDate = iso(seed % 10);
        const lineItems = [];
        let supplierName: string | null = this.suppliers.length
          ? pick(this.suppliers, seed)
          : null;
        if (this.catalog.length > 0) {
          const part = this.catalog[seed % this.catalog.length];
          const source = part.sources[0];
          supplierName = source.vendor;
          const costCents = Math.round(Number(source.unitCost) * 100);
          // 88–100% of the current cost, so approving is an easy call.
          const quotedCents = Math.max(
            1,
            costCents - Math.round((costCents * (seed % 120)) / 1000),
          );
          lineItems.push({
            line_number: 1,
            sku: part.sku,
            description: part.name,
            unit_cost: centsToDollars(quotedCents),
            currency: null,
            country_of_origin: source.countryOfOrigin,
            // The supplier's claimed HTS — display/estimate input only.
            hts_code: part.htsCode,
            moq: 100 * (1 + (seed % 5)),
            lead_time_days: 21 + (seed % 15),
            unit_of_measure: "EA",
          });
        }
        const unknownCostCents = 1600 + (seed % 300); // $16.00–$18.99
        lineItems.push({
          line_number: lineItems.length + 1,
          sku: "EB-RCK-ALU",
          description: "Aluminum rear cargo rack",
          unit_cost: centsToDollars(unknownCostCents),
          currency: null,
          country_of_origin: "CN",
          hts_code: "8714.99.8000",
          moq: 200,
          lead_time_days: 30,
          unit_of_measure: "EA",
        });
        return {
          docType: "quote_sheet",
          fields: {
            supplier_name: supplierName,
            quote_date: quoteDate,
            currency: "USD",
            valid_until: day(30 + (seed % 60)),
            notes: "Prices firm for the validity period.",
            line_items: lineItems,
          },
        };
      }
      case "packing_list":
        return {
          docType: "packing_list",
          fields: {
            bill_of_lading: ctx.bolPool.length ? pick(ctx.bolPool, seed) : null,
            cartons: 50 + (seed % 500),
            gross_weight_kg: 1000 + (seed % 9000),
            referenced_pos: pickSome(ctx.poPool, packetSeed ?? seed, 1),
          },
        };
      case "entry_packet": {
        // A fixed 6-page manifest: 7501 (pp. 1–2), commercial invoice
        // (pp. 3–4), packing list (p. 5), assist sheet (p. 6). The assist
        // sheet exercises the misroute protection — it must become an
        // "other" child, never an invoice. Cross-child facts (invoice
        // number, PO) are derived by the children from the shared
        // storageKey, not fabricated here.
        const parts: PacketPartExtraction[] = [
          {
            part_index: 1,
            role: "entry_summary_7501",
            doc_type: "port_entry",
            title: "Entry Summary 7501",
            pages: [1, 2],
            confidence: "high",
          },
          {
            part_index: 2,
            role: "commercial_invoice",
            doc_type: "commercial_invoice",
            title: "Commercial Invoice",
            pages: [3, 4],
            confidence: "high",
          },
          {
            part_index: 3,
            role: "packing_list",
            doc_type: "packing_list",
            title: "Packing List",
            pages: [5],
            confidence: "high",
          },
          {
            part_index: 4,
            role: "assist_sheet",
            doc_type: "other",
            title: "Assist Sheet",
            pages: [6],
            confidence: "low",
          },
        ];
        return { docType: "entry_packet", fields: { parts } };
      }
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
