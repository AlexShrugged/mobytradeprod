import { and, eq, inArray, isNull } from "drizzle-orm";

import { reauditEntriesForPart } from "@/lib/audit/auditor";
import {
  seedClassificationsForNewParts,
  updatePartHts,
} from "@/lib/classification/service";
import { db, schema } from "@/lib/db";
import { normalizeHts } from "@/lib/duty/calculator";
import { adoptEntryLinesForParts } from "@/lib/processing/linker";
import { normalizeVendorName } from "@/lib/vendors/normalize";
import { findOrCreateVendor, type ResolvedVendor } from "@/lib/vendors/service";
import { buildSkuIndex, normalizeSku, resolveSku } from "./sku";
import { skuKeySql } from "./sku-sql";

import type {
  CatalogField,
  CatalogImportItem,
  ImportIssue,
} from "./import-file";

// The Parts page catalog importer: applies a parsed CSV/XLSX SKU list and
// files the upload as a processed document (docType part_catalog) so it
// shows on the Data page with the import summary as its extracted data.
// Parts/part_sources writes mirror the manual routes (import is a human
// uploading their own catalog, so parts are born ACTIVE, not draft); the
// HTS projection goes through the classification service like every other
// writer.
//
// FUTURE: SKU-level conflict resolution. Today an import row silently
// overwrites whatever the catalog already says (name, description, HTS,
// per-vendor cost/origin) — the launch use case is seeding an empty catalog,
// where conflicts cannot exist. Once catalogs are live, a difference between
// the file and the catalog is a genuine question (which one is right?) that
// deserves a review flow like the HTS queue: stage the incoming value, show
// both sides, let a human decide per SKU. Every overwrite below records a
// field_changes row with source "catalog_import", so the history to build
// that on already exists.

const IMPORT_SOURCE = "catalog_import";

const todayIso = () => new Date().toISOString().slice(0, 10);

export type CatalogImportSummary = {
  documentId: string;
  /** Data rows read from the file (header/blank rows excluded). */
  rows: number;
  /** Distinct SKUs after merging repeated rows. */
  skus: number;
  created: number;
  updated: number;
  unchanged: number;
  sourcesCreated: number;
  sourcesUpdated: number;
  /** Orphaned entry lines (processed before their part existed) adopted
   *  onto imported SKUs — what flips those parts to Active. */
  entryLinesLinked: number;
  issues: ImportIssue[];
};

export async function applyCatalogImport(opts: {
  orgId: string;
  actor: string;
  items: CatalogImportItem[];
  /** Parse-phase issues — recorded on the document alongside apply counts. */
  issues: ImportIssue[];
  columns: Partial<Record<CatalogField, string>>;
  rowCount: number;
  file: {
    fileName: string;
    fileSize: number;
    mimeType: string;
    storageKey: string;
    sourceId: string | null;
  };
}): Promise<CatalogImportSummary> {
  const { orgId, actor, items, file } = opts;

  return db.transaction(async (tx) => {
    // Chunked: a whole-catalog file carries tens of thousands of SKUs, and
    // one bound parameter each would crowd the 65535-parameter cap. Matched
    // on the normalized key (./sku) so a re-import spelling difference
    // updates the live part instead of minting a case-variant duplicate.
    const existingParts: schema.Part[] = [];
    for (let i = 0; i < items.length; i += 5000) {
      existingParts.push(
        ...(await tx.query.parts.findMany({
          where: and(
            eq(schema.parts.orgId, orgId),
            inArray(
              skuKeySql(schema.parts.sku),
              items.slice(i, i + 5000).map((item) => normalizeSku(item.sku)),
            ),
          ),
        })),
      );
    }
    const partIndex = buildSkuIndex(existingParts);

    let updated = 0;
    let unchanged = 0;
    let sourcesCreated = 0;
    let sourcesUpdated = 0;
    const touched: { partId: string; created: boolean }[] = [];
    const reauditPartIds = new Set<string>();

    const recordChange = (
      partId: string,
      vendorId: string | null,
      field: string,
      oldValue: string | null,
      newValue: string | null,
    ) =>
      tx.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: partId,
        vendorId,
        field,
        oldValue,
        newValue,
        source: IMPORT_SOURCE,
        actor,
        note: `Imported from ${file.fileName}`,
      });

    // Vendors resolve once per distinct name, not once per row — a
    // whole-catalog file repeats a hundred suppliers across thousands of
    // rows.
    const vendorByKey = new Map<string, ResolvedVendor>();
    for (const item of items) {
      for (const src of item.sources) {
        const key = normalizeVendorName(src.vendorName);
        if (key === null || vendorByKey.has(key)) continue;
        const vendor = await findOrCreateVendor(tx, orgId, src.vendorName);
        if (vendor) vendorByKey.set(key, vendor);
      }
    }
    const vendorOf = (name: string): ResolvedVendor | null => {
      const key = normalizeVendorName(name);
      return key === null ? null : (vendorByKey.get(key) ?? null);
    };

    // ------------------------------------------------- creates, in bulk
    //
    // The launch use case is a whole catalog into an empty org: tens of
    // thousands of fresh parts. Per-part writes (the update path below)
    // are hundreds of thousands of statements — enough to crash Next's
    // dev runtime — so creates go in chunked bulk inserts instead. Fresh
    // parts have no review items, no entries, and no prior sources, so
    // the per-part machinery has nothing to do; per-field field_changes
    // are also skipped (provenance lives on the classification window,
    // the part_created event, and the document link).
    // Parse yields one item per normalized key, so "no candidates" is the
    // whole new-part test.
    const newItems = items.filter((i) => !partIndex.has(normalizeSku(i.sku)));
    for (let i = 0; i < newItems.length; i += 500) {
      const chunk = newItems.slice(i, i + 500);
      const inserted = await tx
        .insert(schema.parts)
        .values(
          chunk.map((item) => ({
            orgId,
            sku: item.sku,
            // name is not nullable and the SKU code alone identifies
            // nothing — fall back to the description before giving up.
            name: item.name ?? item.description ?? item.sku,
            description: item.description,
            ...(item.unitOfMeasure
              ? { unitOfMeasure: item.unitOfMeasure }
              : {}),
            // The projection; seedClassificationsForNewParts writes the
            // window rows behind it below.
            htsCode: item.htsCode,
            status: "active" as const,
          })),
        )
        .returning({ id: schema.parts.id, sku: schema.parts.sku });

      const idBySku = new Map(inserted.map((p) => [p.sku, p.id]));
      const sourceRows: (typeof schema.partSources.$inferInsert)[] = [];
      const classificationRows: { partId: string; htsCode: string }[] = [];
      for (const item of chunk) {
        const partId = idBySku.get(item.sku);
        if (partId === undefined) continue; // unreachable: insert returned
        touched.push({ partId, created: true });
        if (item.htsCode !== null) {
          classificationRows.push({ partId, htsCode: item.htsCode });
        }
        const seenVendors = new Set<string>();
        for (const src of item.sources) {
          const vendor = vendorOf(src.vendorName);
          if (!vendor || seenVendors.has(vendor.id)) continue;
          seenVendors.add(vendor.id);
          sourceRows.push({
            orgId,
            partId,
            vendorId: vendor.id,
            countryOfOrigin: src.countryOfOrigin,
            unitCost: src.unitCost,
          });
        }
      }
      if (sourceRows.length > 0) {
        await tx.insert(schema.partSources).values(sourceRows);
        sourcesCreated += sourceRows.length;
      }
      await seedClassificationsForNewParts(tx, orgId, classificationRows, {
        source: IMPORT_SOURCE,
        actor,
        note: `Imported from ${file.fileName}`,
      });
    }
    const created = newItems.length;

    // ------------------------------------------- updates, one at a time
    //
    // Overwrites of live catalog rows stay on the careful per-part path:
    // HTS through the classification service (supersede + re-audit),
    // field_changes per overwrite — the history the future conflict-
    // resolution flow builds on.
    for (const item of items) {
      // Case twins with no exact spelling match resolve to null — leave
      // those rows untouched rather than guess which twin the file means.
      let part = resolveSku(partIndex, item.sku) ?? undefined;
      if (!part) continue;
      let changed = false;

      {
        const patch: Partial<typeof schema.parts.$inferInsert> = {};
        if (item.name !== null && item.name !== part.name) {
          patch.name = item.name;
        }
        if (item.description !== null && item.description !== part.description) {
          patch.description = item.description;
        }
        if (
          item.unitOfMeasure !== null &&
          item.unitOfMeasure !== part.unitOfMeasure
        ) {
          patch.unitOfMeasure = item.unitOfMeasure;
        }
        if (Object.keys(patch).length > 0) {
          const fieldNames: [keyof typeof patch, string, string | null][] = [
            ["name", "name", part.name],
            ["description", "description", part.description],
            ["unitOfMeasure", "unit_of_measure", part.unitOfMeasure],
          ];
          [part] = await tx
            .update(schema.parts)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(schema.parts.id, part.id))
            .returning();
          changed = true;
          for (const [key, field, oldValue] of fieldNames) {
            if (patch[key] === undefined) continue;
            await recordChange(part.id, null, field, oldValue, patch[key] as string);
          }
        }
      }

      // Committed through the classification service like every HTS writer
      // (window tiling, review-item supersede, re-audit). Skipped when the
      // committed code already matches — a same-code import should not
      // disturb a pending review.
      if (
        item.htsCode !== null &&
        (part.htsCode === null ||
          part.htsCodeProvisional ||
          normalizeHts(part.htsCode) !== normalizeHts(item.htsCode))
      ) {
        await updatePartHts(tx, orgId, part.id, item.htsCode, {
          actor,
          source: IMPORT_SOURCE,
          note: `Imported from ${file.fileName}`,
        });
        changed = true;
      }

      for (const src of item.sources) {
        const vendor = vendorOf(src.vendorName);
        if (!vendor) continue; // unreachable: parse drops blank vendors

        const current = await tx.query.partSources.findFirst({
          where: and(
            eq(schema.partSources.partId, part.id),
            eq(schema.partSources.vendorId, vendor.id),
            isNull(schema.partSources.validTo),
          ),
        });

        if (current) {
          // Blank cells mean "not provided", never "clear the value" — only
          // fields the file carries overwrite. An undated in-place update
          // matches the sources route's default ("was always so").
          const patch: Partial<typeof schema.partSources.$inferInsert> = {};
          if (
            src.countryOfOrigin !== null &&
            src.countryOfOrigin !== current.countryOfOrigin
          ) {
            patch.countryOfOrigin = src.countryOfOrigin;
          }
          if (
            src.unitCost !== null &&
            Number(src.unitCost) !== Number(current.unitCost ?? NaN)
          ) {
            patch.unitCost = src.unitCost;
          }
          if (Object.keys(patch).length > 0) {
            await tx
              .update(schema.partSources)
              .set({ ...patch, updatedAt: new Date() })
              .where(eq(schema.partSources.id, current.id));
            sourcesUpdated++;
            changed = true;
            if (patch.countryOfOrigin !== undefined) {
              reauditPartIds.add(part.id);
              await recordChange(
                part.id,
                vendor.id,
                "country_of_origin",
                current.countryOfOrigin,
                patch.countryOfOrigin,
              );
            }
            if (patch.unitCost !== undefined) {
              await recordChange(
                part.id,
                vendor.id,
                "unit_cost",
                current.unitCost,
                patch.unitCost,
              );
            }
          }
        } else {
          // Closed windows mean this vendor sourced the part before and was
          // removed — the new window starts today rather than rewriting the
          // gap (same rule as the manual add-source route).
          const priorWindow = await tx.query.partSources.findFirst({
            where: and(
              eq(schema.partSources.partId, part.id),
              eq(schema.partSources.vendorId, vendor.id),
            ),
            columns: { id: true },
          });
          await tx.insert(schema.partSources).values({
            orgId,
            partId: part.id,
            vendorId: vendor.id,
            countryOfOrigin: src.countryOfOrigin,
            unitCost: src.unitCost,
            validFrom: priorWindow ? todayIso() : null,
          });
          sourcesCreated++;
          changed = true;
          for (const [field, value] of [
            ["country_of_origin", src.countryOfOrigin],
            ["unit_cost", src.unitCost],
          ] as const) {
            if (value === null) continue;
            await recordChange(part.id, vendor.id, field, null, value);
          }
          if (src.countryOfOrigin !== null) reauditPartIds.add(part.id);
        }
      }

      if (changed) updated++;
      else unchanged++;
      touched.push({ partId: part.id, created: false });
    }

    // Entry lines processed before their part existed carry part_id null —
    // adopt them onto every SKU this file touches (created or not, so a
    // re-import heals an org whose entries predate the catalog). Runs
    // before the per-part re-audits so those see the adopted lines; the
    // adopter re-audits the entries it links itself.
    const adopted = await adoptEntryLinesForParts(
      tx,
      orgId,
      touched.map((t) => t.partId),
    );

    // A changed COO moves what the auditor expects on this part's entry
    // lines. updatePartHts re-audits its own changes; duplicates here are
    // harmless (alert_key reconcile is idempotent) but skipped anyway.
    for (const partId of reauditPartIds) {
      await reauditEntriesForPart(tx, orgId, partId);
    }

    const summaryIssues = opts.issues.slice(0, 200);
    const [document] = await tx
      .insert(schema.documents)
      .values({
        orgId,
        fileName: file.fileName,
        fileSize: file.fileSize,
        mimeType: file.mimeType,
        storageKey: file.storageKey,
        docType: "part_catalog",
        // Born processed: the importer already applied it; the document
        // pipeline (sweep, process route) must never pick it up.
        status: "processed",
        sourceId: file.sourceId,
        extractedData: {
          kind: "part_catalog_import",
          rows: opts.rowCount,
          skus: items.length,
          created,
          updated,
          unchanged,
          sources_created: sourcesCreated,
          sources_updated: sourcesUpdated,
          entry_lines_linked: adopted.linkedLines,
          columns: opts.columns,
          issues: summaryIssues,
        },
        processedBy: IMPORT_SOURCE,
        processedAt: new Date(),
      })
      .returning();

    for (let i = 0; i < touched.length; i += 500) {
      await tx.insert(schema.documentLinks).values(
        touched.slice(i, i + 500).map((t) => ({
          orgId,
          documentId: document.id,
          entityType: "part" as const,
          entityId: t.partId,
          created: t.created,
        })),
      );
    }

    return {
      documentId: document.id,
      rows: opts.rowCount,
      skus: items.length,
      created,
      updated,
      unchanged,
      sourcesCreated,
      sourcesUpdated,
      entryLinesLinked: adopted.linkedLines,
      issues: opts.issues,
    };
  });
}
