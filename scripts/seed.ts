// Deterministic demo seed for MobyTrade: "Waystar Royco", an e-bike
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
import { ADCVD_ORDER_SEED } from "../src/lib/db/seed-data/adcvd-orders";
import { buildStory, VENDOR_SEED } from "../src/lib/db/seed-data/story";
import type { DocLinkSeed } from "../src/lib/db/seed-data/story";
import { normalizeHts } from "../src/lib/duty/calculator";
import { loadReferenceData } from "../src/lib/duty/reference";

const DAY = 86_400_000;
const FILES_DIR = "./.files";

/** Entry numbers normalize to digits only ("231-4501287-4" → "23145012874"). */
const normalizeEntryNumber = (n: string) => n.replace(/\D/g, "");

/** Minimal valid PDF with `pages` blank pages (packet parents are
 *  multi-page); the comment line varies the byte size. */
const placeholderPdf = (fileName: string, pages = 1) => {
  const pageIds = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`);
  return [
    "%PDF-1.4",
    `% MobyTrade seed placeholder — ${fileName}`,
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    `2 0 obj << /Type /Pages /Kids [${pageIds.join(" ")}] /Count ${pages} >> endobj`,
    ...pageIds.map(
      (_, i) =>
        `${3 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj`,
    ),
    "trailer << /Root 1 0 R >>",
    "%%EOF",
    "",
  ].join("\n");
};

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
  await db.delete(schema.analysisFindings);
  await db.delete(schema.analysisRuns);
  await db.delete(schema.adcvdOrders);
  await db.delete(schema.auditAlerts);
  await db.delete(schema.entryLineCharges);
  await db.delete(schema.entryLineItems);
  await db.delete(schema.refundClaims);
  await db.delete(schema.entryInvoices);
  await db.delete(schema.invoiceLineItems);
  await db.delete(schema.invoices);
  await db.delete(schema.fieldChanges);
  await db.delete(schema.partClassifications);
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
  await db.delete(schema.partSources);
  await db.delete(schema.parts);
  await db.delete(schema.vendors);
  await db.delete(schema.scenarios);
  await db.delete(schema.proposedMeasures);
  await db.delete(schema.measureRevisions);
  await db.delete(schema.measureRevisionGroups);
  await db.delete(schema.tariffAnnouncements);
  await db.delete(schema.tradeMeasureHts);
  await db.delete(schema.htsCodes);
  await db.delete(schema.stackingRules);
  await db.delete(schema.tradeMeasures);
  await db.delete(schema.orgs);

  // ------------------------------------------------------------- org
  // SEED_CLERK_ORG_ID binds the seed org to a dev-instance Clerk
  // organization so signed-in dev sessions resolve to the seeded data.
  const [org] = await db
    .insert(schema.orgs)
    .values({
      ...story.org,
      clerkOrgId: process.env.SEED_CLERK_ORG_ID ?? null,
    })
    .returning();
  const orgId = org.id;

  // ------------------------------------------------------------- vendors
  // Canonical names only (resolution is trim+casefold, so a suffix variant
  // would mint a second vendor). Every supplier string in the story must
  // resolve here — the lookups below throw on a miss.
  const insertedVendors = await db
    .insert(schema.vendors)
    .values(
      VENDOR_SEED.map((name) => ({
        orgId,
        name,
        nameNormalized: name.trim().toLowerCase(),
      })),
    )
    .returning({ id: schema.vendors.id, name: schema.vendors.name });
  const vendorIdByNameMap = Object.fromEntries(
    insertedVendors.map((v) => [v.name, v.id]),
  );
  const vendorIdByName = (name: string): string => {
    const id = vendorIdByNameMap[name];
    if (!id) throw new Error(`story references unknown vendor "${name}"`);
    return id;
  };

  // ------------------------------------------- tariff reference data
  // Global tables (no org): Chapter 99 measures + their rows, the base
  // HTS schedule subset, and stacking rules.
  for (const m of buildMeasureSeed(day)) {
    const [measure] = await db
      .insert(schema.tradeMeasures)
      .values({
        name: m.name,
        authority: m.authority,
        program: m.program,
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

  // AD/CVD order corpus — global reference context for the AI analyst
  // (never an input to deterministic duty math).
  await db.insert(schema.adcvdOrders).values(ADCVD_ORDER_SEED);

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
  // ./.files/ so downloads work; fileSize is the real byte count. Packet
  // children share their parent's file (storageKey + size) and only add a
  // role + page range — no file of their own.
  mkdirSync(FILES_DIR, { recursive: true });
  const docIdByFile: Record<string, string> = {};
  const fileSizeByName: Record<string, number> = {};
  for (const d of story.documents) {
    let storageKey: string;
    let fileSize: number;
    if (d.packet) {
      if (!docIdByFile[d.packet.parentFileName]) {
        throw new Error(
          `packet child ${d.fileName} listed before its parent ${d.packet.parentFileName}`,
        );
      }
      storageKey = d.packet.parentFileName;
      fileSize = fileSizeByName[d.packet.parentFileName];
    } else {
      const pdf = placeholderPdf(d.fileName, d.pages ?? 1);
      writeFileSync(join(FILES_DIR, d.fileName), pdf);
      storageKey = d.fileName;
      fileSize = Buffer.byteLength(pdf);
      fileSizeByName[d.fileName] = fileSize;
    }
    const [doc] = await db
      .insert(schema.documents)
      .values({
        orgId,
        fileName: d.fileName,
        fileSize,
        mimeType: "application/pdf",
        storageKey,
        docType: d.docType,
        status: "processed",
        sourceId: sourceIdByKind[d.sourceKind],
        extractedData: d.extractedData,
        processedBy: "stub",
        uploadedAt: d.uploadedAt,
        processedAt: new Date(d.uploadedAt.getTime() + 90_000),
        parentDocumentId: d.packet ? docIdByFile[d.packet.parentFileName] : null,
        packetRole: d.packet?.role ?? null,
        pageRange: d.packet?.pageRange ?? null,
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
        htsCode: p.htsCode,
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

  // Classification windows: story-driven history where present (the
  // EB-DSP-LCD reclassification), else one open-start current window per
  // part with a committed code — as-of audits then reproduce current-state
  // behavior exactly for unreclassified parts.
  const windowsBySku = new Map<string, typeof story.classificationWindows>();
  for (const w of story.classificationWindows) {
    const list = windowsBySku.get(w.sku) ?? [];
    list.push(w);
    windowsBySku.set(w.sku, list);
  }
  await db.insert(schema.partClassifications).values(
    story.parts.flatMap((p, i) => {
      const onboarded = p.status === "draft" ? at(-2, 9) : at(-210 + i * 3, 9);
      const history = windowsBySku.get(p.sku);
      if (history) {
        return history.map((w) => ({
          orgId,
          partId: partIdBySku[p.sku],
          htsCode: w.htsCode,
          validFrom: w.validFrom,
          validTo: w.validTo,
          source: w.source,
          actor: w.actor,
          note: w.note,
          createdAt: w.recordedAt,
          updatedAt: w.recordedAt,
        }));
      }
      if (p.htsCode === null) return [];
      return [
        {
          orgId,
          partId: partIdBySku[p.sku],
          htsCode: p.htsCode,
          validFrom: null as string | null,
          validTo: null as string | null,
          source: "seed",
          actor: null as string | null,
          note: null as string | null,
          createdAt: onboarded,
          updatedAt: onboarded,
        },
      ];
    }),
  );

  // One field_changes row per reclassification transition so the events
  // feed narrates it (occurredOn = the decision's recordedAt).
  for (const [sku, history] of windowsBySku) {
    const ordered = [...history].sort((a, b) =>
      (a.validFrom ?? "").localeCompare(b.validFrom ?? ""),
    );
    for (let i = 1; i < ordered.length; i++) {
      await db.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: partIdBySku[sku],
        field: "hts_code",
        oldValue: ordered[i - 1].htsCode,
        newValue: ordered[i].htsCode,
        source: ordered[i].source,
        actor: ordered[i].actor,
        note: ordered[i].note,
        createdAt: ordered[i].recordedAt,
      });
    }
  }

  // The (part, vendor) sourcing facts — COO and cost live here, not on the
  // part. Timestamps track the part's onboarding.
  await db.insert(schema.partSources).values(
    story.parts.flatMap((p, i) =>
      p.sources.map((s) => ({
        orgId,
        partId: partIdBySku[p.sku],
        vendorId: vendorIdByName(s.vendor),
        countryOfOrigin: s.countryOfOrigin,
        unitCost: s.unitCost,
        createdAt: p.status === "draft" ? at(-2, 9) : at(-210 + i * 3, 9),
        updatedAt: p.status === "draft" ? at(-2, 9) : at(-210 + i * 3, 9),
      })),
    ),
  );

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
        vendorId: vendorIdByName(po.supplierName),
        orderDate: po.orderDate,
        expectedDate: po.expectedDate,
        currency: "USD",
        totalAmount: po.totalAmount.toFixed(2),
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
          countryOfOrigin: l.countryOfOrigin ?? null,
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
          supplierName: line.supplierName,
          vendorId: vendorIdByName(line.supplierName),
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

  // ---------------------------------------------------- commercial invoices
  // Directly linked to entries via entry_invoices — the CI is the primary
  // document the variance rules compare against (see story.ts for the four
  // planted findings).
  const invoiceIdByNumber: Record<string, string> = {};
  for (const inv of story.invoices) {
    const [row] = await db
      .insert(schema.invoices)
      .values({
        orgId,
        invoiceNumber: inv.invoiceNumber,
        purchaseOrderId: poIdByNumber[inv.poNumber],
        supplierName: inv.supplierName,
        vendorId: vendorIdByName(inv.supplierName),
        invoiceDate: inv.invoiceDate,
        currency: inv.currency,
        totalAmount: inv.totalAmount.toFixed(2),
        incoterms: inv.incoterms,
      })
      .returning({ id: schema.invoices.id });
    invoiceIdByNumber[inv.invoiceNumber] = row.id;

    await db.insert(schema.invoiceLineItems).values(
      inv.lines.map((l) => ({
        orgId,
        invoiceId: row.id,
        lineNumber: l.lineNumber,
        partId: partIdBySku[l.sku] ?? null,
        sku: l.sku,
        description: l.description,
        countryOfOrigin: l.countryOfOrigin,
        htsCode: l.htsCode,
        htsCodeDigits: l.htsCode ? normalizeHts(l.htsCode) : null,
        quantity: l.quantity.toFixed(4),
        unitPrice: l.unitPrice.toFixed(4),
        totalPrice: (
          l.totalPrice ?? Math.round(l.quantity * l.unitPrice * 100) / 100
        ).toFixed(2),
      })),
    );
  }
  await db.insert(schema.entryInvoices).values(
    story.entryInvoiceLinks.map(([e, i]) => ({
      orgId,
      entryId: entryIdByNumber[e],
      invoiceId: invoiceIdByNumber[i],
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
        vendorId: vendorIdByName(qs.supplierName),
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
      invoice: invoiceIdByNumber,
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
  // $0 exclusion claim on line 3), the sourcing plant on 231-4501341-1,
  // and the classification plant on 231-4501320-0.
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

  // The sourcing plant on the air entry: EB-CTRL-V2 declared CN under the
  // Hanoi vendor (catalog VN) — the coo_discrepancy must fire, and nothing
  // else (the charges match the declared CN, so money rules stay quiet).
  const sourcingKeys = keysByEntry.get(entryIdByNumber["231-4501341-1"]) ?? [];
  assertSeed(
    sourcingKeys.includes("coo_discrepancy:line2"),
    `entry 231-4501341-1 must flag the declared-vs-catalog origin on line 2, got: ${sourcingKeys.join(", ")}`,
  );
  assertSeed(
    sourcingKeys.length === 1,
    `entry 231-4501341-1 must carry ONLY the origin finding, got: ${sourcingKeys.join(", ")}`,
  );

  // The classification plant: EB-BRK-HYD declared under the dutiable
  // 8714.94.9000 while the catalog says 8714.94.3080 (free). Only the
  // hts_discrepancy may fire — charges are internally consistent under the
  // declared code, and classification doubt suspends the money rules.
  const classificationKeys =
    keysByEntry.get(entryIdByNumber["231-4501320-0"]) ?? [];
  assertSeed(
    classificationKeys.includes("hts_discrepancy:line1"),
    `entry 231-4501320-0 must flag the brake misclassification, got: ${classificationKeys.join(", ")}`,
  );
  assertSeed(
    classificationKeys.length === 1,
    `entry 231-4501320-0 must carry ONLY the HTS finding, got: ${classificationKeys.join(", ")}`,
  );

  // ------------------------------------- CI-vs-entry plants (exact sets)
  const assertExactKeys = (entryNumber: string, expected: string[]) => {
    const got = [...(keysByEntry.get(entryIdByNumber[entryNumber]) ?? [])].sort();
    const want = [...expected].sort();
    assertSeed(
      got.length === want.length && got.every((k, i) => k === want[i]),
      `entry ${entryNumber} open alerts must be exactly [${want.join(", ")}], got: [${got.join(", ")}]`,
    );
  };
  // Entry 2: the reclassification signal plus the CI origin plant and the
  // CI's missing SKU (whose coverage gap also silences the header value
  // check).
  assertExactKeys("231-4501293-1", [
    "hts_reclassified:line1",
    "coo_discrepancy:invoice_sku:EB-DSP-LCD",
    "invoice_sku_missing:invoice_sku:EB-MTR-500W",
  ]);
  // Entry 3: the CI prints a different 6-digit HS subheading for the
  // controller; values match, so nothing else fires.
  assertExactKeys("231-4501305-2", [
    "invoice_hts_mismatch:invoice_sku:EB-CTRL-V2",
  ]);
  // Entry 6: $500 over-declared vs the CI — the header failure gates open
  // the per-SKU value alert on the wheel.
  assertExactKeys("231-4501334-6", [
    "value_mismatch:invoice_total",
    "value_mismatch:invoice_sku:EB-WHL-27F",
  ]);
  // Entry 8: the stacked line — every issue class that can coexist on one
  // line (plus the entry-level header-value alert that gates the per-SKU
  // one). NO hts_discrepancy by design: it would suspend rate/amount.
  assertExactKeys("231-4501347-8", [
    "rate_mismatch:line1:base",
    "amount_mismatch:line1:base",
    "missing_measure:line1:99030125",
    "invoice_hts_mismatch:invoice_sku:EB-BAT-52V",
    "coo_discrepancy:invoice_sku:EB-BAT-52V",
    "value_mismatch:invoice_total",
    "value_mismatch:invoice_sku:EB-BAT-52V",
    "quantity_discrepancy:invoice_sku:EB-BAT-52V",
  ]);

  // The analysis-defect entries (see seed-data/analysis-defects.ts) must be
  // INVISIBLE to the deterministic engine — their defects live in fee
  // bounds, document extracted_data, and the description-vs-code axis, which
  // only the AI entry analyst reads. A key appearing here means a plant
  // leaked into deterministic territory.
  assertExactKeys("231-4501352-6", []);
  assertExactKeys("231-4501358-3", []);
  assertExactKeys("231-4501364-1", []);

  // -------------------------------------------------------------- summary
  const count = async (table: Parameters<typeof db.$count>[0]) => db.$count(table);
  const counts = {
    orgs: await count(schema.orgs),
    vendors: await count(schema.vendors),
    parts: await count(schema.parts),
    part_sources: await count(schema.partSources),
    part_classifications: await count(schema.partClassifications),
    purchase_orders: await count(schema.purchaseOrders),
    purchase_order_lines: await count(schema.purchaseOrderLines),
    shipments: await count(schema.shipments),
    entries: await count(schema.entries),
    entry_line_items: await count(schema.entryLineItems),
    entry_line_charges: await count(schema.entryLineCharges),
    entry_shipments: await count(schema.entryShipments),
    entry_purchase_orders: await count(schema.entryPurchaseOrders),
    shipment_purchase_orders: await count(schema.shipmentPurchaseOrders),
    invoices: await count(schema.invoices),
    invoice_line_items: await count(schema.invoiceLineItems),
    entry_invoices: await count(schema.entryInvoices),
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
    adcvd_orders: await count(schema.adcvdOrders),
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
