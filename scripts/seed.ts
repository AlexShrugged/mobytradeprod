// Deterministic demo seed for MobyTrade: "Countless Industries", an e-bike
// importer, with ~6 months of entries/shipments/POs, a quote pipeline, two
// refund claims, and the tariff reference tables — every date anchored to
// the day the seed runs (see day()/at()) so the demo, including the
// Section 122 sail-tiled measure pair, never goes stale.
//
// Run with `npm run db:seed` (stop the dev server first — PGlite is
// single-process, and it caches the org id: restart it after reseeding).
// tsx runs this as CJS — no top-level await; everything lives in main().

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

// Relative imports on purpose: tsx does not resolve the `@/` alias here.
import { db, schema } from "../src/lib/db";
import { auditEntry } from "../src/lib/audit/auditor";
import {
  BASE_RELEASE,
  BASE_VALID_FROM,
  buildMeasureSeed,
  HTS_SEED,
  STACKING_SEED,
} from "../src/lib/db/seed-data/tariff";
import { buildStory } from "../src/lib/db/seed-data/story";
import type { DocLinkSeed } from "../src/lib/db/seed-data/story";
import { normalizeHts } from "../src/lib/duty/calculator";
import { loadReferenceData } from "../src/lib/duty/reference";

const DAY = 86_400_000;
const FILES_DIR = "./.files";

/** Entry numbers normalize to digits only ("231-4501287-4" → "23145012874"). */
const normalizeEntryNumber = (n: string) => n.replace(/\D/g, "");

/** Minimal valid single-page PDF; the comment line varies the byte size. */
const placeholderPdf = (fileName: string) =>
  [
    "%PDF-1.4",
    `% MobyTrade seed placeholder — ${fileName}`,
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
    "",
  ].join("\n");

async function main() {
  console.log("Seeding mobytrade database…");

  // Date helpers — the ONLY way the seed produces dates.
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  /** ISO date `i` days from today (negative = past). */
  const day = (i: number) => new Date(todayUtc + i * DAY).toISOString().slice(0, 10);
  /** Date `i` days from today at a fixed UTC time. */
  const at = (i: number, hour: number, minute = 0) =>
    new Date(todayUtc + i * DAY + hour * 3_600_000 + minute * 60_000);
  /** Fixed offset before run time — integration telemetry only. */
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  const story = buildStory(day, at, hoursAgo);

  // ------------------------------------------------------------- wipe
  // Children first, in FK order. Every new table must be added here.
  await db.delete(schema.auditAlerts);
  await db.delete(schema.entryLineCharges);
  await db.delete(schema.entryLineItems);
  await db.delete(schema.refundClaims);
  await db.delete(schema.invoiceLineItems);
  await db.delete(schema.invoices);
  await db.delete(schema.fieldChanges);
  await db.delete(schema.reviewItems);
  await db.delete(schema.htsClassificationCandidates);
  await db.delete(schema.htsClassifications);
  await db.delete(schema.quoteLines);
  await db.delete(schema.quoteSheets);
  await db.delete(schema.documentLinks);
  await db.delete(schema.documents);
  await db.delete(schema.integrationSources);
  await db.delete(schema.entryShipments);
  await db.delete(schema.entryPurchaseOrders);
  await db.delete(schema.shipmentPurchaseOrders);
  await db.delete(schema.purchaseOrderLines);
  await db.delete(schema.entries);
  await db.delete(schema.shipments);
  await db.delete(schema.purchaseOrders);
  await db.delete(schema.parts);
  await db.delete(schema.scenarios);
  await db.delete(schema.proposedMeasures);
  await db.delete(schema.measureRevisions);
  await db.delete(schema.tariffAnnouncements);
  await db.delete(schema.tradeMeasureHts);
  await db.delete(schema.htsCodes);
  await db.delete(schema.stackingRules);
  await db.delete(schema.tradeMeasures);
  await db.delete(schema.orgs);

  // ------------------------------------------------------------- org
  const [org] = await db.insert(schema.orgs).values(story.org).returning();
  const orgId = org.id;

  // ------------------------------------------- tariff reference data
  // Global tables (no org): Chapter 99 measures + their rows, the base
  // HTS schedule subset, and stacking rules.
  for (const m of buildMeasureSeed(day)) {
    const [measure] = await db
      .insert(schema.tradeMeasures)
      .values({
        name: m.name,
        authority: m.authority,
        scope: m.scope,
        countries: m.countries,
        effectiveDate: m.effectiveDate,
        endDate: m.endDate,
        sailedOnOrAfter: m.sailedOnOrAfter ?? null,
        sailedOnOrBefore: m.sailedOnOrBefore ?? null,
        inLieuOfBaseDuty: m.inLieuOfBaseDuty,
        notes: m.notes,
      })
      .returning({ id: schema.tradeMeasures.id });

    // Chapter 99 rows: valid_from/valid_to stay null — measure windows
    // govern, not base-schedule change-tiling.
    await db.insert(schema.htsCodes).values(
      m.ch99.map((c) => ({
        code: c.code,
        codeDigits: normalizeHts(c.code),
        description: c.description,
        chapter: 99,
        rateType: "ad_valorem" as const,
        rate: c.rate.toFixed(6),
        tradeMeasureId: measure.id,
        exemption: c.exemption,
      })),
    );

    if (m.prefixes.length) {
      await db.insert(schema.tradeMeasureHts).values(
        m.prefixes.map((htsPrefix) => ({ tradeMeasureId: measure.id, htsPrefix })),
      );
    }
  }

  // Base schedule: one open-ended change-tiling window per code.
  await db.insert(schema.htsCodes).values(
    HTS_SEED.map((h) => {
      const codeDigits = normalizeHts(h.code);
      return {
        code: h.code,
        codeDigits,
        description: h.description,
        chapter: Number(codeDigits.slice(0, 2)),
        rateType: h.rateType,
        rate: h.rate === null ? null : h.rate.toFixed(6),
        col1General: h.col1General,
        validFrom: BASE_VALID_FROM,
        validTo: null,
        release: BASE_RELEASE,
      };
    }),
  );

  await db.insert(schema.stackingRules).values(STACKING_SEED);

  // ------------------------------------------------ integration sources
  const sourceIdByKind: Record<string, string> = {};
  for (const s of story.integrationSources) {
    const [row] = await db
      .insert(schema.integrationSources)
      .values({
        orgId,
        kind: s.kind,
        name: s.name,
        status: s.status,
        config: s.config,
        lastReceivedAt: s.lastReceivedAt,
        lastRunAt: s.lastRunAt,
      })
      .returning({ id: schema.integrationSources.id });
    sourceIdByKind[s.kind] = row.id;
  }

  // ------------------------------------------------------------ documents
  // Inserted before quote sheets (which FK them); document_links land last,
  // once every linked entity exists. Placeholder PDFs are written to
  // ./.files/ so downloads work; fileSize is the real byte count.
  mkdirSync(FILES_DIR, { recursive: true });
  const docIdByFile: Record<string, string> = {};
  for (const d of story.documents) {
    const pdf = placeholderPdf(d.fileName);
    writeFileSync(join(FILES_DIR, d.fileName), pdf);
    const [doc] = await db
      .insert(schema.documents)
      .values({
        orgId,
        fileName: d.fileName,
        fileSize: Buffer.byteLength(pdf),
        mimeType: "application/pdf",
        storageKey: d.fileName,
        docType: d.docType,
        status: "processed",
        sourceId: sourceIdByKind[d.sourceKind],
        extractedData: d.extractedData,
        processedBy: "stub",
        uploadedAt: d.uploadedAt,
        processedAt: new Date(d.uploadedAt.getTime() + 90_000),
      })
      .returning({ id: schema.documents.id });
    docIdByFile[d.fileName] = doc.id;
  }

  // ---------------------------------------------------------------- parts
  const insertedParts = await db
    .insert(schema.parts)
    .values(
      story.parts.map((p, i) => ({
        orgId,
        sku: p.sku,
        name: p.name,
        manufacturer: p.manufacturer,
        htsCode: p.htsCode,
        countryOfOrigin: p.countryOfOrigin,
        unitCost: p.unitCost,
        status: p.status,
        htsReviewStatus: p.htsReviewStatus,
        // Catalog onboarding predates the first PO, staggered so "SKU
        // created" events don't all pile onto seed day; the draft part was
        // created BY its quote sheet, so its creation matches that date.
        createdAt: p.status === "draft" ? at(-2, 9) : at(-210 + i * 3, 9),
        updatedAt: p.status === "draft" ? at(-2, 9) : at(-210 + i * 3, 9),
      })),
    )
    .returning({ id: schema.parts.id, sku: schema.parts.sku });
  const partIdBySku = Object.fromEntries(insertedParts.map((p) => [p.sku, p.id]));
  const partName = Object.fromEntries(story.parts.map((p) => [p.sku, p.name]));

  // ------------------------------------------------------ purchase orders
  const poIdByNumber: Record<string, string> = {};
  const poLineId: Record<string, string> = {}; // "PO-2026-005#1" → id
  for (const po of story.purchaseOrders) {
    const [row] = await db
      .insert(schema.purchaseOrders)
      .values({
        orgId,
        poNumber: po.poNumber,
        supplierName: po.supplierName,
        orderDate: po.orderDate,
        expectedDate: po.expectedDate,
        currency: "USD",
        totalAmount: po.totalAmount.toFixed(2),
        status: po.status,
      })
      .returning({ id: schema.purchaseOrders.id });
    poIdByNumber[po.poNumber] = row.id;

    const lines = await db
      .insert(schema.purchaseOrderLines)
      .values(
        po.lines.map((l) => ({
          orgId,
          purchaseOrderId: row.id,
          lineNumber: l.lineNumber,
          partId: partIdBySku[l.sku],
          sku: l.sku,
          description: partName[l.sku],
          quantity: l.quantity.toFixed(4),
          unitPrice: l.unitPrice.toFixed(4),
          totalPrice: (Math.round(l.quantity * l.unitPrice * 100) / 100).toFixed(2),
        })),
      )
      .returning({
        id: schema.purchaseOrderLines.id,
        lineNumber: schema.purchaseOrderLines.lineNumber,
      });
    for (const l of lines) poLineId[`${po.poNumber}#${l.lineNumber}`] = l.id;
  }

  // ------------------------------------------------------------ shipments
  const insertedShipments = await db
    .insert(schema.shipments)
    .values(story.shipments.map((s) => ({ orgId, ...s })))
    .returning({
      id: schema.shipments.id,
      shipmentNumber: schema.shipments.shipmentNumber,
    });
  const shipmentIdByNumber = Object.fromEntries(
    insertedShipments.map((s) => [s.shipmentNumber, s.id]),
  );

  // -------------------------------------------------------------- entries
  const entryIdByNumber: Record<string, string> = {};
  for (const e of story.entries) {
    const [row] = await db
      .insert(schema.entries)
      .values({
        orgId,
        entryNumber: e.entryNumber,
        entryDate: e.entryDate,
        portOfEntry: e.portOfEntry,
        entryType: e.entryType,
        importerOfRecord: story.org.importerOfRecord,
        status: e.status,
        totalEnteredValue: e.totals.enteredValue.toFixed(2),
        totalDuty: e.totals.duty.toFixed(2),
        totalBaseDuty: e.totals.baseDuty.toFixed(2),
        // MPF/HMF are ingested facts (no HMF on the air entry).
        mpfAmount: e.totals.mpf.toFixed(2),
        hmfAmount: e.totals.hmf === null ? null : e.totals.hmf.toFixed(2),
        totalRefund: e.totalRefund === null ? null : e.totalRefund.toFixed(2),
      })
      .returning({ id: schema.entries.id });
    entryIdByNumber[e.entryNumber] = row.id;

    for (const line of e.lines) {
      const [lineRow] = await db
        .insert(schema.entryLineItems)
        .values({
          orgId,
          entryId: row.id,
          lineNumber: line.lineNumber,
          partId: partIdBySku[line.sku],
          sku: line.sku,
          description: line.description,
          htsCode: line.htsCode,
          htsCodeDigits: normalizeHts(line.htsCode),
          countryOfOrigin: line.countryOfOrigin,
          quantity: line.quantity.toFixed(4),
          unitValue: line.unitValue.toFixed(4),
          enteredValue: line.enteredValue.toFixed(2),
        })
        .returning({ id: schema.entryLineItems.id });

      await db.insert(schema.entryLineCharges).values(
        line.charges.map((c) => ({
          orgId,
          lineItemId: lineRow.id,
          chargeType: c.chargeType,
          htsCode: c.htsCode,
          htsCodeDigits: c.htsCode ? normalizeHts(c.htsCode) : null,
          rate: c.rate === null ? null : c.rate.toFixed(6),
          amount: c.amount.toFixed(2),
        })),
      );
    }
  }

  // ----------------------------------------------------------- link matrix
  await db.insert(schema.entryShipments).values(
    story.entryShipmentLinks.map(([e, s]) => ({
      orgId,
      entryId: entryIdByNumber[e],
      shipmentId: shipmentIdByNumber[s],
    })),
  );
  await db.insert(schema.entryPurchaseOrders).values(
    story.entryPoLinks.map(([e, p]) => ({
      orgId,
      entryId: entryIdByNumber[e],
      purchaseOrderId: poIdByNumber[p],
    })),
  );
  await db.insert(schema.shipmentPurchaseOrders).values(
    story.shipmentPoLinks.map(([s, p]) => ({
      orgId,
      shipmentId: shipmentIdByNumber[s],
      purchaseOrderId: poIdByNumber[p],
    })),
  );

  // -------------------------------------------------------------- refunds
  const refundIdByKey: Record<string, string> = {};
  for (const rc of story.refundClaims) {
    const [row] = await db
      .insert(schema.refundClaims)
      .values({
        orgId,
        entrySummaryNumber: rc.entryNumber,
        normalizedEntryNumber: normalizeEntryNumber(rc.entryNumber),
        entryId: entryIdByNumber[rc.entryNumber],
        claimType: rc.claimType,
        claimStatus: rc.claimStatus,
        refundStatus: rc.refundStatus,
        refundNumber: rc.refundNumber,
        refundClassAmount: rc.refundClassAmount,
        refundInterestAmount: rc.refundInterestAmount,
        entryDate: rc.entryDate,
        liquidationDate: rc.liquidationDate,
        refundDate: rc.refundDate,
      })
      .returning({ id: schema.refundClaims.id });
    refundIdByKey[rc.key] = row.id;
    // entries.totalRefund was seeded in the entry insert above; assert the
    // two stay in sync rather than trusting the literals.
    const entry = story.entries.find((e) => e.entryNumber === rc.entryNumber);
    const claimTotal =
      Number(rc.refundClassAmount) + Number(rc.refundInterestAmount);
    if (!entry || entry.totalRefund !== claimTotal) {
      throw new Error(
        `refund claim ${rc.key} (${claimTotal}) out of sync with ` +
          `entries.totalRefund (${entry?.totalRefund}) on ${rc.entryNumber}`,
      );
    }
  }

  // --------------------------------------------------------------- quotes
  const quoteSheetIdByKey: Record<string, string> = {};
  for (const qs of story.quoteSheets) {
    const [sheet] = await db
      .insert(schema.quoteSheets)
      .values({
        orgId,
        documentId: qs.documentFile ? docIdByFile[qs.documentFile] : null,
        supplierName: qs.supplierName,
        quoteDate: qs.quoteDate,
        currency: "USD",
        validUntil: qs.validUntil,
        notes: qs.notes,
      })
      .returning({ id: schema.quoteSheets.id });
    quoteSheetIdByKey[qs.key] = sheet.id;

    await db.insert(schema.quoteLines).values(
      qs.lines.map((l) => ({
        orgId,
        quoteSheetId: sheet.id,
        lineNumber: l.lineNumber,
        partId: partIdBySku[l.sku],
        partCreated: l.partCreated,
        sku: l.sku,
        description: l.description,
        unitCost: l.unitCost,
        currency: "USD",
        countryOfOrigin: l.countryOfOrigin,
        htsCode: l.htsCode,
        moq: l.moq,
        leadTimeDays: l.leadTimeDays,
        unitOfMeasure: "EA",
        status: l.status,
        decidedBy: l.decidedBy,
        decidedAt: l.decidedAt,
        decisionNote: l.decisionNote,
        appliedAt: l.appliedAt,
        appliedPoLineId: l.appliedPoLineRef
          ? poLineId[`${l.appliedPoLineRef.poNumber}#${l.appliedPoLineRef.lineNumber}`]
          : null,
      })),
    );
  }

  // -------------------------------------------------------- document links
  const entityIdFor = (l: DocLinkSeed): string => {
    const id = {
      entry: entryIdByNumber,
      shipment: shipmentIdByNumber,
      purchase_order: poIdByNumber,
      quote_sheet: quoteSheetIdByKey,
      refund_claim: refundIdByKey,
      part: partIdBySku,
    }[l.entityType][l.key];
    if (!id) throw new Error(`document link references unknown ${l.entityType} ${l.key}`);
    return id;
  };
  await db.insert(schema.documentLinks).values(
    story.documents.flatMap((d) =>
      d.links.map((l) => ({
        orgId,
        documentId: docIdByFile[d.fileName],
        entityType: l.entityType,
        entityId: entityIdFor(l),
        created: l.created,
      })),
    ),
  );

  // ---------------------------------------------------------------- audit
  //
  // Run the real auditor over the seeded entries so alerts exist on first
  // boot — audit_alerts are the auditor's computed output, never
  // hand-seeded — then hard-assert the planted findings on 231-4501311-9
  // (rate_mismatch line 1, missing_measure line 2, and NO finding for the
  // $0 exclusion claim on line 3).
  const ref = await loadReferenceData(db);
  for (const e of story.entries) {
    await auditEntry(db, orgId, entryIdByNumber[e.entryNumber], ref);
  }

  const openAlerts = await db.query.auditAlerts.findMany({
    where: eq(schema.auditAlerts.status, "open"),
  });
  const keysByEntry = new Map<string, string[]>();
  for (const a of openAlerts) {
    const list = keysByEntry.get(a.entryId) ?? [];
    list.push(a.alertKey);
    keysByEntry.set(a.entryId, list);
  }
  const assertSeed = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`Seed assertion failed: ${msg}`);
  };

  assertSeed(
    (keysByEntry.get(entryIdByNumber["231-4501287-4"]) ?? []).length === 0,
    `entry 231-4501287-4 should audit clean, got: ${(keysByEntry.get(entryIdByNumber["231-4501287-4"]) ?? []).join(", ")}`,
  );
  const plantedKeys = keysByEntry.get(entryIdByNumber["231-4501311-9"]) ?? [];
  assertSeed(
    plantedKeys.includes("rate_mismatch:line1:99038801"),
    "entry 231-4501311-9 must flag the Section 301 List 1 rate mismatch",
  );
  assertSeed(
    plantedKeys.includes("amount_mismatch:line1:99038801"),
    "entry 231-4501311-9 must flag the Section 301 List 1 amount mismatch",
  );
  assertSeed(
    plantedKeys.includes("missing_measure:line2:99038803"),
    "entry 231-4501311-9 must flag the missing Section 301 List 3 charge",
  );
  assertSeed(
    !plantedKeys.some((k) => k.includes("line3")),
    `the $0 exclusion claim on line 3 must never be flagged, got: ${plantedKeys.join(", ")}`,
  );

  // -------------------------------------------------------------- summary
  const count = async (table: Parameters<typeof db.$count>[0]) => db.$count(table);
  const counts = {
    orgs: await count(schema.orgs),
    parts: await count(schema.parts),
    purchase_orders: await count(schema.purchaseOrders),
    purchase_order_lines: await count(schema.purchaseOrderLines),
    shipments: await count(schema.shipments),
    entries: await count(schema.entries),
    entry_line_items: await count(schema.entryLineItems),
    entry_line_charges: await count(schema.entryLineCharges),
    entry_shipments: await count(schema.entryShipments),
    entry_purchase_orders: await count(schema.entryPurchaseOrders),
    shipment_purchase_orders: await count(schema.shipmentPurchaseOrders),
    refund_claims: await count(schema.refundClaims),
    quote_sheets: await count(schema.quoteSheets),
    quote_lines: await count(schema.quoteLines),
    documents: await count(schema.documents),
    document_links: await count(schema.documentLinks),
    integration_sources: await count(schema.integrationSources),
    trade_measures: await count(schema.tradeMeasures),
    trade_measure_hts: await count(schema.tradeMeasureHts),
    hts_codes: await count(schema.htsCodes),
    stacking_rules: await count(schema.stackingRules),
    audit_alerts: await count(schema.auditAlerts),
  };
  console.log("Seeded:", counts);
  console.log("Seed complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
