// One-time repair for the 2026-08-19 ASC ingestion incident: a cargo
// release ("MobyTrade Part 5.pdf") classified as port_entry created entry
// 231-7354574-7 with no entry date and a phantom shipment
// (SHP-RIM266009107); the same batch minted a duplicate shipment from the
// dash/no-dash AWB spelling ("180-61914941" vs "18061914941") and a
// literal purchase order named "8119907E7,8119908E2" from a multi-PO
// commercial invoice.
//
// What it does, inside one transaction over the target org:
//   1. Reclassifies the named release documents to doc_type cargo_release
//      (extracted_data rewritten to the release shape) and relinks them
//      attach-only: entry link kept with created=false, phantom shipment
//      links dropped, real shipment link kept.
//   2. Backfills each entry's null header fields (entry date, importer)
//      from the port_entry document extraction that carries them.
//   3. Merges duplicate shipments that share a normalized BOL — links,
//      shipment_purchase_orders, and transport details move to the row
//      the entries point at; the duplicate is deleted.
//   4. Deletes the named phantom shipments (release reference numbers
//      extracted as BOLs) and their links.
//   5. Splits comma-joined purchase orders: real POs are found-or-created,
//      invoices and links repointed, the comma row deleted.
//   6. Re-audits every touched entry.
//
// Requires the cargo_release enum value: run db:migrate first.
//
//   DATABASE_URL=... npx tsx scripts/repair-asc-ingestion.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/repair-asc-ingestion.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, inArray, sql } from "drizzle-orm";

import { auditEntry } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import type { DbClient } from "../src/lib/duty/reference";
import { normalizeBol, splitReferenceNumbers } from "../src/lib/processing/normalize";
import { normalizeEntryNumber } from "../src/lib/refunds";

const ORG_NAME = "ASC";
// Misclassified releases, by file name, with the BOLs that are real
// transport documents (everything else extracted was a reference number).
const RELEASES: { fileName: string; realBols: string[] }[] = [
  { fileName: "MobyTrade Part 5.pdf", realBols: ["180-61914941"] },
];
// Shipments minted from release reference numbers — not real BOLs.
const PHANTOM_BOLS = ["RIM266009107"];

class Rollback extends Error {}

async function run(tx: DbClient, log: (m: string) => void): Promise<void> {
  const org = await tx.query.orgs.findFirst({
    where: eq(schema.orgs.name, ORG_NAME),
  });
  if (!org) throw new Error(`org "${ORG_NAME}" not found`);
  const orgId = org.id;
  const touchedEntryIds = new Set<string>();

  // ---- 1. reclassify the misclassified releases -------------------------
  for (const release of RELEASES) {
    const doc = await tx.query.documents.findFirst({
      where: and(
        eq(schema.documents.orgId, orgId),
        eq(schema.documents.fileName, release.fileName),
      ),
    });
    if (!doc) {
      log(`release "${release.fileName}": not found, skipping`);
      continue;
    }
    const extracted = (doc.extractedData ?? {}) as Record<string, unknown>;
    const entryNumber = String(extracted.entry_number ?? "");
    if (!entryNumber) throw new Error(`release ${doc.fileName}: no entry_number`);

    await tx
      .update(schema.documents)
      .set({
        docType: "cargo_release",
        extractedData: {
          entry_number: entryNumber,
          entry_date: null,
          referenced_bols: release.realBols,
        },
        updatedAt: new Date(),
      })
      .where(eq(schema.documents.id, doc.id));

    // Attach-only links: keep the entry link (created=false — the 7501 is
    // the entry's paperwork of record), drop every shipment link, re-add
    // links to the real shipments only.
    await tx
      .update(schema.documentLinks)
      .set({ created: false })
      .where(eq(schema.documentLinks.documentId, doc.id));
    await tx
      .delete(schema.documentLinks)
      .where(
        and(
          eq(schema.documentLinks.documentId, doc.id),
          eq(schema.documentLinks.entityType, "shipment"),
        ),
      );
    for (const bol of release.realBols) {
      const shipment = await tx.query.shipments.findFirst({
        where: and(
          eq(schema.shipments.orgId, orgId),
          sql`regexp_replace(upper(${schema.shipments.billOfLading}), '[^A-Z0-9]', '', 'g') = ${normalizeBol(bol)}`,
        ),
      });
      if (shipment) {
        await tx
          .insert(schema.documentLinks)
          .values({
            orgId,
            documentId: doc.id,
            entityType: "shipment",
            entityId: shipment.id,
            created: false,
          })
          .onConflictDoNothing();
      }
    }
    log(`release "${doc.fileName}": doc_type -> cargo_release, links rebuilt`);
  }

  // ---- 2. backfill entry headers from 7501 extractions ------------------
  const entries = await tx.query.entries.findMany({
    where: eq(schema.entries.orgId, orgId),
  });
  const portEntryDocs = await tx.query.documents.findMany({
    where: and(
      eq(schema.documents.orgId, orgId),
      eq(schema.documents.docType, "port_entry"),
      eq(schema.documents.status, "processed"),
    ),
  });
  for (const entry of entries) {
    const source = portEntryDocs.find((d) => {
      const ex = (d.extractedData ?? {}) as Record<string, unknown>;
      return (
        normalizeEntryNumber(String(ex.entry_number ?? "")) ===
          normalizeEntryNumber(entry.entryNumber) && ex.entry_date != null
      );
    });
    if (!source) continue;
    const ex = (source.extractedData ?? {}) as Record<string, unknown>;
    const fill: Record<string, unknown> = {};
    if (entry.entryDate === null) fill.entryDate = String(ex.entry_date);
    // The release's importer casing is not the 7501's — overwrite from the
    // authoritative document, not just gap-fill.
    if (
      typeof ex.importer_of_record === "string" &&
      entry.importerOfRecord !== ex.importer_of_record
    )
      fill.importerOfRecord = ex.importer_of_record;
    if (entry.portOfEntry === null && ex.port_of_entry != null)
      fill.portOfEntry = String(ex.port_of_entry);
    if (entry.entryType === null && ex.entry_type != null)
      fill.entryType = String(ex.entry_type);
    if (Object.keys(fill).length === 0) continue;
    await tx
      .update(schema.entries)
      .set({ ...fill, updatedAt: new Date() })
      .where(eq(schema.entries.id, entry.id));
    touchedEntryIds.add(entry.id);
    log(
      `entry ${entry.entryNumber}: backfilled ${Object.keys(fill).join(", ")} from "${source.fileName}"`,
    );
  }

  // ---- 3. merge duplicate shipments (same normalized BOL) ---------------
  const shipments = await tx.query.shipments.findMany({
    where: eq(schema.shipments.orgId, orgId),
  });
  const byNorm = new Map<string, typeof shipments>();
  for (const s of shipments) {
    if (!s.billOfLading) continue;
    const key = normalizeBol(s.billOfLading);
    (byNorm.get(key) ?? byNorm.set(key, []).get(key)!).push(s);
  }
  for (const [norm, group] of byNorm) {
    if (group.length < 2) continue;
    // Target: the row the entry graph points at, else the oldest.
    // Sequential — one tx client, and pg deprecates overlapping queries.
    const linkCounts: number[] = [];
    for (const s of group) {
      const rows = await tx.query.entryShipments.findMany({
        where: eq(schema.entryShipments.shipmentId, s.id),
      });
      linkCounts.push(rows.length);
    }
    const targetIdx = linkCounts.indexOf(Math.max(...linkCounts));
    const target = group[targetIdx];
    for (const dup of group) {
      if (dup.id === target.id) continue;
      // Transport details: the duplicate usually IS the real transport
      // document's row — fill the target's gaps and take the evidenced
      // mode over the stub default.
      await tx
        .update(schema.shipments)
        .set({
          mode: dup.mode ?? target.mode,
          carrier: target.carrier ?? dup.carrier,
          vessel: target.vessel ?? dup.vessel,
          containerNumber: target.containerNumber ?? dup.containerNumber,
          originPort: target.originPort ?? dup.originPort,
          destinationPort: target.destinationPort ?? dup.destinationPort,
          etd: target.etd ?? dup.etd,
          eta: target.eta ?? dup.eta,
          sailedOnBoardDate: target.sailedOnBoardDate ?? dup.sailedOnBoardDate,
          updatedAt: new Date(),
        })
        .where(eq(schema.shipments.id, target.id));

      const dupDocLinks = await tx.query.documentLinks.findMany({
        where: and(
          eq(schema.documentLinks.entityType, "shipment"),
          eq(schema.documentLinks.entityId, dup.id),
        ),
      });
      for (const link of dupDocLinks) {
        await tx
          .insert(schema.documentLinks)
          .values({ ...link, entityId: target.id })
          .onConflictDoNothing();
      }
      const dupPoLinks = await tx.query.shipmentPurchaseOrders.findMany({
        where: eq(schema.shipmentPurchaseOrders.shipmentId, dup.id),
      });
      for (const link of dupPoLinks) {
        await tx
          .insert(schema.shipmentPurchaseOrders)
          .values({ ...link, shipmentId: target.id })
          .onConflictDoNothing();
      }
      const dupEntryLinks = await tx.query.entryShipments.findMany({
        where: eq(schema.entryShipments.shipmentId, dup.id),
      });
      for (const link of dupEntryLinks) {
        await tx
          .insert(schema.entryShipments)
          .values({ ...link, shipmentId: target.id })
          .onConflictDoNothing();
        touchedEntryIds.add(link.entryId);
      }
      await tx
        .delete(schema.documentLinks)
        .where(
          and(
            eq(schema.documentLinks.entityType, "shipment"),
            eq(schema.documentLinks.entityId, dup.id),
          ),
        );
      await tx
        .delete(schema.shipmentPurchaseOrders)
        .where(eq(schema.shipmentPurchaseOrders.shipmentId, dup.id));
      await tx
        .delete(schema.entryShipments)
        .where(eq(schema.entryShipments.shipmentId, dup.id));
      await tx.delete(schema.shipments).where(eq(schema.shipments.id, dup.id));
      log(
        `shipment ${dup.shipmentNumber} merged into ${target.shipmentNumber} (BOL ${norm})`,
      );
    }
  }

  // ---- 4. delete phantom shipments --------------------------------------
  for (const bol of PHANTOM_BOLS) {
    const phantom = await tx.query.shipments.findFirst({
      where: and(
        eq(schema.shipments.orgId, orgId),
        sql`regexp_replace(upper(${schema.shipments.billOfLading}), '[^A-Z0-9]', '', 'g') = ${normalizeBol(bol)}`,
      ),
    });
    if (!phantom) continue;
    const entryLinks = await tx.query.entryShipments.findMany({
      where: eq(schema.entryShipments.shipmentId, phantom.id),
    });
    for (const link of entryLinks) touchedEntryIds.add(link.entryId);
    await tx
      .delete(schema.documentLinks)
      .where(
        and(
          eq(schema.documentLinks.entityType, "shipment"),
          eq(schema.documentLinks.entityId, phantom.id),
        ),
      );
    await tx
      .delete(schema.entryShipments)
      .where(eq(schema.entryShipments.shipmentId, phantom.id));
    await tx
      .delete(schema.shipmentPurchaseOrders)
      .where(eq(schema.shipmentPurchaseOrders.shipmentId, phantom.id));
    await tx.delete(schema.shipments).where(eq(schema.shipments.id, phantom.id));
    log(`phantom shipment ${phantom.shipmentNumber} deleted`);
  }

  // ---- 5. split comma-joined purchase orders ----------------------------
  const pos = await tx.query.purchaseOrders.findMany({
    where: eq(schema.purchaseOrders.orgId, orgId),
  });
  for (const po of pos) {
    const parts = splitReferenceNumbers(po.poNumber);
    if (parts.length < 2) continue;
    const realIds: string[] = [];
    for (const number of parts) {
      const existing = pos.find((p) => p.poNumber === number);
      if (existing) {
        realIds.push(existing.id);
        continue;
      }
      const [created] = await tx
        .insert(schema.purchaseOrders)
        .values({ orgId, poNumber: number })
        .returning({ id: schema.purchaseOrders.id });
      realIds.push(created.id);
      log(`created PO ${number}`);
    }
    // Repoint everything hanging off the comma row; the primary PO for
    // single-column references is the first number, matching the linker.
    await tx
      .update(schema.invoices)
      .set({ purchaseOrderId: realIds[0], updatedAt: new Date() })
      .where(eq(schema.invoices.purchaseOrderId, po.id));
    await tx
      .update(schema.purchaseOrderLines)
      .set({ purchaseOrderId: realIds[0] })
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id));
    const docLinks = await tx.query.documentLinks.findMany({
      where: and(
        eq(schema.documentLinks.entityType, "purchase_order"),
        eq(schema.documentLinks.entityId, po.id),
      ),
    });
    for (const link of docLinks) {
      for (const realId of realIds) {
        await tx
          .insert(schema.documentLinks)
          .values({ ...link, entityId: realId, created: false })
          .onConflictDoNothing();
      }
    }
    for (const table of [
      schema.entryPurchaseOrders,
      schema.shipmentPurchaseOrders,
    ] as const) {
      const rows = await tx
        .select()
        .from(table)
        .where(eq(table.purchaseOrderId, po.id));
      for (const row of rows) {
        for (const realId of realIds) {
          await tx
            .insert(table)
            .values({ ...row, purchaseOrderId: realId })
            .onConflictDoNothing();
        }
        if ("entryId" in row) touchedEntryIds.add(row.entryId as string);
      }
      await tx.delete(table).where(eq(table.purchaseOrderId, po.id));
    }
    await tx
      .delete(schema.documentLinks)
      .where(
        and(
          eq(schema.documentLinks.entityType, "purchase_order"),
          eq(schema.documentLinks.entityId, po.id),
        ),
      );
    await tx
      .delete(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, po.id));
    log(`PO "${po.poNumber}" split into ${parts.join(" + ")} and deleted`);
  }

  // ---- 6. re-audit ------------------------------------------------------
  for (const entryId of touchedEntryIds) {
    await auditEntry(tx, orgId, entryId);
  }
  log(`re-audited ${touchedEntryIds.size} entr${touchedEntryIds.size === 1 ? "y" : "ies"}`);

  // Sanity: no entry left dateless, no duplicate normalized BOLs.
  const dateless = await tx
    .select({ n: schema.entries.entryNumber })
    .from(schema.entries)
    .where(
      and(eq(schema.entries.orgId, orgId), sql`${schema.entries.entryDate} is null`),
    );
  const dupBols = await tx
    .select({
      norm: sql<string>`regexp_replace(upper(${schema.shipments.billOfLading}), '[^A-Z0-9]', '', 'g')`,
      count: sql<number>`count(*)`,
    })
    .from(schema.shipments)
    .where(
      and(
        eq(schema.shipments.orgId, orgId),
        sql`${schema.shipments.billOfLading} is not null`,
      ),
    )
    .groupBy(sql`1`)
    .having(sql`count(*) > 1`);
  log(
    `post-check: ${dateless.length} dateless entr(ies), ${dupBols.length} duplicate BOL group(s)`,
  );
}

async function main() {
  const apply = process.argv.includes("--apply");
  const log = (m: string) => console.log(m);
  try {
    await db.transaction(async (tx) => {
      await run(tx, log);
      if (!apply) throw new Rollback();
    });
  } catch (err) {
    if (err instanceof Rollback) {
      console.log("\nDRY RUN — rolled back, nothing written.");
      return;
    }
    throw err;
  }
  console.log("\nAPPLIED.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
