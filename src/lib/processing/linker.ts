import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { auditEntry } from "@/lib/audit/auditor";
import { db, schema, type DbClient } from "@/lib/db";
import { normalizeHts } from "@/lib/duty/calculator";
import { buildSkuIndex, normalizeSku, resolveSku } from "@/lib/parts/sku";
import { skuKeySql } from "@/lib/parts/sku-sql";
import { applyQuotesForPo, ingestQuoteSheet } from "@/lib/quotes/service";
import { normalizeEntryNumber } from "@/lib/refunds";
import { findOrCreateVendor } from "@/lib/vendors/service";
import { normalizeBol, splitReferenceNumbers } from "./normalize";
import type { EntryLineItemExtraction, ExtractionResult } from "./types";

// ISO codes compare exact-match downstream (measure gating, COO audit rule).
// The mappers normalize too — this is the write-side guarantee.
const toCoo = (v: string | null | undefined): string | null =>
  v?.trim().toUpperCase() || null;

const DUTY_CHARGE_TYPES = new Set([
  "base_duty",
  "additional_duty",
  "antidumping",
  "countervailing",
]);

// Header money: prefer the extraction's own header figures, fall back to
// sums over the declared lines. total_base_duty is always derived — no
// document carries a base-only header figure.
function entryHeaderTotals(
  lineItems: EntryLineItemExtraction[],
  header: {
    totalEnteredValue: number | null;
    totalDuty: number | null;
    mpfAmount: number | null;
    hmfAmount: number | null;
  },
) {
  const sums = { entered: 0, duty: 0, base: 0, mpf: 0, hmf: 0 }; // cents
  for (const li of lineItems) {
    sums.entered += Math.round(li.entered_value * 100);
    for (const c of li.charges) {
      const cents = Math.round(c.amount * 100);
      if (c.charge_type === "base_duty") sums.base += cents;
      if (DUTY_CHARGE_TYPES.has(c.charge_type)) sums.duty += cents;
      else if (c.charge_type === "mpf") sums.mpf += cents;
      else if (c.charge_type === "hmf") sums.hmf += cents;
    }
  }
  const pick = (headerVal: number | null, cents: number) =>
    (headerVal ?? cents / 100).toFixed(2);
  return {
    totalEnteredValue: pick(header.totalEnteredValue, sums.entered),
    totalDuty: pick(header.totalDuty, sums.duty),
    totalBaseDuty: (sums.base / 100).toFixed(2),
    mpfAmount: pick(header.mpfAmount, sums.mpf),
    hmfAmount: pick(header.hmfAmount, sums.hmf),
  };
}

type LinkedEntity = (typeof schema.linkedEntityType.enumValues)[number];

// Turns an extraction into domain records: create the record a document
// represents if it's new, attach referenced records by their business
// numbers (creating stubs for unknown ones), and write document_links for
// everything touched. This is where the many-to-many graph gets built.
//
// Single-writer boundaries: this module owns the entry graph (entries,
// shipments, POs + PO lines, invoices, entry_invoices, refund claims,
// document_links); the quote tables belong to quotes/service.ts, which the
// quote_sheet case delegates into IN the same transaction.
//
// ctx.parentDocumentId is set for packet children: sibling parts of the
// same packet dock to each other through it (a CI links to the entries its
// sibling 7501 created, and vice versa — parts process in any order).
export async function linkExtraction(
  orgId: string,
  documentId: string,
  extraction: ExtractionResult,
  ctx: { parentDocumentId?: string | null } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const links: { entityType: LinkedEntity; entityId: string; created: boolean }[] = [];

    // BOLs match on normalized form — the same AWB prints "180-61914941" on
    // a 7501 and "18061914941" on the waybill, and an exact-string match
    // mints two shipments for one sailing. The first-seen printed form is
    // what the row keeps for display.
    const findShipmentByBol = (bol: string) =>
      tx.query.shipments.findFirst({
        where: and(
          eq(schema.shipments.orgId, orgId),
          sql`regexp_replace(upper(${schema.shipments.billOfLading}), '[^A-Z0-9]', '', 'g') = ${normalizeBol(bol)}`,
        ),
      });

    const findOrCreateShipmentByBol = async (bol: string) => {
      const existing = await findShipmentByBol(bol);
      if (existing) return { id: existing.id, created: false };
      const [created] = await tx
        .insert(schema.shipments)
        .values({
          orgId,
          shipmentNumber: `SHP-${bol}`,
          billOfLading: bol,
        })
        .returning({ id: schema.shipments.id });
      return { id: created.id, created: true };
    };

    const findOrCreatePoByNumber = async (poNumber: string) => {
      const existing = await tx.query.purchaseOrders.findFirst({
        where: and(
          eq(schema.purchaseOrders.orgId, orgId),
          eq(schema.purchaseOrders.poNumber, poNumber),
        ),
      });
      if (existing) return { id: existing.id, created: false };
      const [created] = await tx
        .insert(schema.purchaseOrders)
        .values({ orgId, poNumber })
        .returning({ id: schema.purchaseOrders.id });
      return { id: created.id, created: true };
    };

    // A stub invoice row for a number the 7501 references before the CI
    // itself is ingested — the CI later upserts the same row by
    // (org, invoice number), and existing entry_invoices rows keep pointing
    // at it. Mirrors findOrCreatePoByNumber.
    const findOrCreateInvoiceByNumber = async (invoiceNumber: string) => {
      const existing = await tx.query.invoices.findFirst({
        where: and(
          eq(schema.invoices.orgId, orgId),
          eq(schema.invoices.invoiceNumber, invoiceNumber),
        ),
      });
      if (existing) return { id: existing.id, created: false };
      const [created] = await tx
        .insert(schema.invoices)
        .values({ orgId, invoiceNumber })
        .returning({ id: schema.invoices.id });
      return { id: created.id, created: true };
    };

    const linkEntryInvoice = (entryId: string, invoiceId: string) =>
      tx
        .insert(schema.entryInvoices)
        .values({ orgId, entryId, invoiceId })
        .onConflictDoNothing();

    // Entity ids of one type linked by SIBLING packet parts (other children
    // of this document's parent) — the packet docking mechanism. Stale
    // entry_invoices rows from a previous split are deliberately never
    // garbage-collected here: they record a business link keyed by
    // entry/invoice identity, and resolved audit state may hang off them.
    const siblingEntityIds = async (entityType: LinkedEntity) => {
      if (!ctx.parentDocumentId) return [];
      const rows = await tx
        .select({ entityId: schema.documentLinks.entityId })
        .from(schema.documentLinks)
        .innerJoin(
          schema.documents,
          eq(schema.documentLinks.documentId, schema.documents.id),
        )
        .where(
          and(
            eq(schema.documents.parentDocumentId, ctx.parentDocumentId),
            eq(schema.documentLinks.entityType, entityType),
            ne(schema.documentLinks.documentId, documentId),
          ),
        );
      return [...new Set(rows.map((r) => r.entityId))];
    };

    // Declared supplier name → resolved vendor id (find-or-create) for a
    // batch of extracted names. Distinct raw spellings that normalize alike
    // land on one vendor row; blank names resolve to nothing.
    const vendorIdsByName = async (rawNames: (string | null)[]) => {
      const names = [
        ...new Set(rawNames.filter((n): n is string => n !== null)),
      ];
      const map = new Map<string, string>();
      for (const name of names) {
        const vendor = await findOrCreateVendor(tx, orgId, name);
        if (vendor) map.set(name, vendor.id);
      }
      return map;
    };

    // (org, sku) → part for a batch of extracted SKUs, one inArray query.
    // Matched on the normalized key (parts/sku.ts) — extraction casing or
    // padding must not orphan a line from its catalog part.
    const partIndexBySku = async (rawSkus: (string | null)[]) => {
      const keys = [
        ...new Set(
          rawSkus
            .map((s) => normalizeSku(s))
            .filter((s): s is string => s !== null),
        ),
      ];
      const matched = keys.length
        ? await tx.query.parts.findMany({
            where: and(
              eq(schema.parts.orgId, orgId),
              inArray(skuKeySql(schema.parts.sku), keys),
            ),
            columns: { id: true, sku: true },
          })
        : [];
      return buildSkuIndex(matched);
    };

    switch (extraction.docType) {
      case "port_entry": {
        const f = extraction.fields;
        let entryId: string;
        const existing = await tx.query.entries.findFirst({
          where: and(
            eq(schema.entries.orgId, orgId),
            eq(schema.entries.entryNumber, f.entry_number),
          ),
        });
        if (existing) {
          entryId = existing.id;
          // A weaker document can win the processing race and create the
          // entry first (a misclassified release once did, minting dateless
          // entries). The 7501 is authoritative for its own header, so fill
          // every fact still missing — gap-fill only, a human-corrected
          // value is never displaced.
          const headerFill: Partial<{
            entryDate: string;
            portOfEntry: string;
            entryType: string;
            importerOfRecord: string;
          }> = {};
          if (existing.entryDate === null && f.entry_date !== null)
            headerFill.entryDate = f.entry_date;
          if (existing.portOfEntry === null && f.port_of_entry !== null)
            headerFill.portOfEntry = f.port_of_entry;
          if (existing.entryType === null && f.entry_type !== null)
            headerFill.entryType = f.entry_type;
          if (existing.importerOfRecord === null && f.importer_of_record !== null)
            headerFill.importerOfRecord = f.importer_of_record;
          if (Object.keys(headerFill).length > 0) {
            await tx
              .update(schema.entries)
              .set({ ...headerFill, updatedAt: new Date() })
              .where(eq(schema.entries.id, entryId));
          }
          links.push({ entityType: "entry", entityId: entryId, created: false });
        } else {
          const [created] = await tx
            .insert(schema.entries)
            .values({
              orgId,
              entryNumber: f.entry_number,
              entryDate: f.entry_date,
              portOfEntry: f.port_of_entry,
              entryType: f.entry_type,
              importerOfRecord: f.importer_of_record,
            })
            .returning({ id: schema.entries.id });
          entryId = created.id;
          links.push({ entityType: "entry", entityId: entryId, created: true });
        }

        for (const bol of f.referenced_bols) {
          const shipment = await findOrCreateShipmentByBol(bol);
          await tx
            .insert(schema.entryShipments)
            .values({ orgId, entryId, shipmentId: shipment.id })
            .onConflictDoNothing();
          links.push({
            entityType: "shipment",
            entityId: shipment.id,
            created: shipment.created,
          });
        }
        for (const poNumber of f.referenced_pos.flatMap(splitReferenceNumbers)) {
          const po = await findOrCreatePoByNumber(poNumber);
          await tx
            .insert(schema.entryPurchaseOrders)
            .values({ orgId, entryId, purchaseOrderId: po.id })
            .onConflictDoNothing();
          links.push({
            entityType: "purchase_order",
            entityId: po.id,
            created: po.created,
          });
        }
        // Direct entry↔invoice links: (a) invoice numbers the 7501
        // references (stub invoice rows for not-yet-ingested CIs), and
        // (b) invoices created by sibling parts of the same packet.
        for (const invoiceNumber of f.referenced_invoices) {
          const invoice = await findOrCreateInvoiceByNumber(invoiceNumber);
          await linkEntryInvoice(entryId, invoice.id);
          links.push({
            entityType: "invoice",
            entityId: invoice.id,
            created: invoice.created,
          });
        }
        for (const invoiceId of await siblingEntityIds("invoice")) {
          await linkEntryInvoice(entryId, invoiceId);
          links.push({
            entityType: "invoice",
            entityId: invoiceId,
            created: false,
          });
        }

        // Line items + declared charges: replace wholesale. Charges cascade
        // with their lines; audit alerts survive via set-null and re-attach
        // by alert_key on the next audit pass.
        if (f.line_items.length > 0) {
          const partIndex = await partIndexBySku(
            f.line_items.map((li) => li.sku),
          );
          const vendorIdByName = await vendorIdsByName(
            f.line_items.map((li) => li.supplier_name),
          );

          await tx
            .delete(schema.entryLineItems)
            .where(eq(schema.entryLineItems.entryId, entryId));

          for (const li of f.line_items) {
            const [lineRow] = await tx
              .insert(schema.entryLineItems)
              .values({
                orgId,
                entryId,
                lineNumber: li.line_number,
                partId: resolveSku(partIndex, li.sku)?.id ?? null,
                sku: li.sku,
                description: li.description,
                htsCode: li.hts_code,
                htsCodeDigits: normalizeHts(li.hts_code),
                spi: li.spi ?? null,
                countryOfOrigin: toCoo(li.country_of_origin),
                supplierName: li.supplier_name,
                vendorId: li.supplier_name
                  ? (vendorIdByName.get(li.supplier_name) ?? null)
                  : null,
                quantity: li.quantity?.toFixed(4) ?? null,
                unitValue: li.unit_value?.toFixed(4) ?? null,
                enteredValue: li.entered_value.toFixed(2),
              })
              .returning({ id: schema.entryLineItems.id });

            if (li.charges.length > 0) {
              await tx.insert(schema.entryLineCharges).values(
                li.charges.map((c) => ({
                  orgId,
                  lineItemId: lineRow.id,
                  chargeType: c.charge_type,
                  htsCode: c.hts_code,
                  htsCodeDigits: c.hts_code ? normalizeHts(c.hts_code) : null,
                  rate: c.rate?.toFixed(6) ?? null,
                  amount: c.amount.toFixed(2),
                })),
              );
            }
          }

          await tx
            .update(schema.entries)
            .set({
              ...entryHeaderTotals(f.line_items, {
                totalEnteredValue: f.total_entered_value,
                totalDuty: f.total_duty,
                mpfAmount: f.mpf_amount,
                hmfAmount: f.hmf_amount,
              }),
              updatedAt: new Date(),
            })
            .where(eq(schema.entries.id, entryId));
        }

        // Cargo releases attach-only (they never create entries), so one
        // that processed before this 7501 found nothing to link to. Adopt
        // strays by extracted entry number, whichever side arrived first —
        // the same both-directions linkage adoptEntryLinesForParts does for
        // parts. Idempotent: the PK on document_links absorbs reruns.
        const strayReleases = await tx
          .select({ id: schema.documents.id })
          .from(schema.documents)
          .where(
            and(
              eq(schema.documents.orgId, orgId),
              eq(schema.documents.docType, "cargo_release"),
              ne(schema.documents.id, documentId),
              sql`regexp_replace(${schema.documents.extractedData}->>'entry_number', '[^0-9]', '', 'g') = ${normalizeEntryNumber(f.entry_number)}`,
            ),
          );
        for (const stray of strayReleases) {
          await tx
            .insert(schema.documentLinks)
            .values({
              orgId,
              documentId: stray.id,
              entityType: "entry",
              entityId: entryId,
              created: false,
            })
            .onConflictDoNothing();
        }

        await auditEntry(tx, orgId, entryId);
        break;
      }

      // Attach-only: a release identifies its entry and shipment(s) but is
      // authoritative for none of them. Link what already exists, create
      // NOTHING — the dateless header-less entries a release used to mint
      // are exactly the bug this class exists to prevent. A release that
      // processes before its 7501 stays unlinked until the 7501's stray-
      // adoption pass picks it up.
      case "cargo_release": {
        const f = extraction.fields;
        const entry = await tx.query.entries.findFirst({
          where: and(
            eq(schema.entries.orgId, orgId),
            sql`regexp_replace(${schema.entries.entryNumber}, '[^0-9]', '', 'g') = ${normalizeEntryNumber(f.entry_number)}`,
          ),
        });
        if (entry) {
          links.push({ entityType: "entry", entityId: entry.id, created: false });
        }
        for (const bol of f.referenced_bols) {
          const shipment = await findShipmentByBol(bol);
          if (shipment) {
            links.push({
              entityType: "shipment",
              entityId: shipment.id,
              created: false,
            });
          }
        }
        break;
      }

      case "refund_report": {
        const f = extraction.fields;
        const orgEntries = await tx.query.entries.findMany({
          where: eq(schema.entries.orgId, orgId),
          columns: { id: true, entryNumber: true },
        });
        const entryByNorm = new Map(
          orgEntries.map((e) => [normalizeEntryNumber(e.entryNumber), e.id]),
        );
        const touchedEntries = new Set<string>();

        for (const claim of f.claims) {
          const normalized = normalizeEntryNumber(claim.entry_summary_number);
          const matchedEntryId = entryByNorm.get(normalized) ?? null;

          const values = {
            normalizedEntryNumber: normalized,
            entryId: matchedEntryId,
            claimStatus: claim.claim_status,
            refundStatus: claim.refund_status,
            refundNumber: claim.refund_number,
            refundClassAmount: claim.refund_class_amount.toFixed(2),
            refundInterestAmount: claim.refund_interest_amount.toFixed(2),
            entryDate: claim.entry_date,
            liquidationDate: claim.liquidation_date,
            refundDate: claim.refund_date,
          };

          const existing = await tx.query.refundClaims.findFirst({
            where: and(
              eq(schema.refundClaims.orgId, orgId),
              eq(
                schema.refundClaims.entrySummaryNumber,
                claim.entry_summary_number,
              ),
              eq(schema.refundClaims.claimType, claim.claim_type),
            ),
          });

          if (existing) {
            // Later reports advance a claim in place — the ES-022 pattern
            // where "accepted" later becomes "transmitted".
            await tx
              .update(schema.refundClaims)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(schema.refundClaims.id, existing.id));
            links.push({
              entityType: "refund_claim",
              entityId: existing.id,
              created: false,
            });
          } else {
            const [created] = await tx
              .insert(schema.refundClaims)
              .values({
                orgId,
                entrySummaryNumber: claim.entry_summary_number,
                claimType: claim.claim_type,
                ...values,
              })
              .returning({ id: schema.refundClaims.id });
            links.push({
              entityType: "refund_claim",
              entityId: created.id,
              created: true,
            });
          }

          if (matchedEntryId) {
            touchedEntries.add(matchedEntryId);
            links.push({
              entityType: "entry",
              entityId: matchedEntryId,
              created: false,
            });
          }
        }

        // Keep entries.total_refund in sync with linked claims.
        for (const touchedId of touchedEntries) {
          const claims = await tx.query.refundClaims.findMany({
            where: eq(schema.refundClaims.entryId, touchedId),
            columns: { refundClassAmount: true, refundInterestAmount: true },
          });
          let cents = 0;
          for (const c of claims) {
            cents +=
              Math.round(Number(c.refundClassAmount) * 100) +
              Math.round(Number(c.refundInterestAmount) * 100);
          }
          await tx
            .update(schema.entries)
            .set({ totalRefund: (cents / 100).toFixed(2), updatedAt: new Date() })
            .where(eq(schema.entries.id, touchedId));
        }
        break;
      }

      case "shipment": {
        const f = extraction.fields;
        let shipmentId: string;
        const existing = await findShipmentByBol(f.bill_of_lading);
        if (existing) {
          shipmentId = existing.id;
          // Stubs created from a port entry's referenced BOLs carry no
          // transport detail; the shipment document is authoritative for
          // its own BOL. Overwrite dates, fill gaps elsewhere, then
          // re-audit linked entries — the sail window may have changed.
          const sailChanged =
            (f.etd ?? existing.etd) !== existing.etd ||
            (f.shipped_on_board_date ?? existing.sailedOnBoardDate) !==
              existing.sailedOnBoardDate;
          await tx
            .update(schema.shipments)
            .set({
              etd: f.etd ?? existing.etd,
              eta: f.eta ?? existing.eta,
              sailedOnBoardDate:
                f.shipped_on_board_date ?? existing.sailedOnBoardDate,
              // The doc class evidences the mode (BOL vs AWB) — an extracted
              // mode overwrites; the column default is not a fact to keep.
              mode: f.mode ?? existing.mode,
              containerNumber: existing.containerNumber ?? f.container_number,
              carrier: existing.carrier ?? f.carrier,
              vessel: existing.vessel ?? f.vessel,
              originPort: existing.originPort ?? f.origin_port,
              destinationPort: existing.destinationPort ?? f.destination_port,
              updatedAt: new Date(),
            })
            .where(eq(schema.shipments.id, shipmentId));
          if (sailChanged) {
            const linked = await tx.query.entryShipments.findMany({
              where: eq(schema.entryShipments.shipmentId, shipmentId),
              columns: { entryId: true },
            });
            for (const { entryId } of linked) {
              await auditEntry(tx, orgId, entryId);
            }
          }
          links.push({ entityType: "shipment", entityId: shipmentId, created: false });
        } else {
          const [created] = await tx
            .insert(schema.shipments)
            .values({
              orgId,
              shipmentNumber: `SHP-${f.bill_of_lading}`,
              billOfLading: f.bill_of_lading,
              containerNumber: f.container_number,
              carrier: f.carrier,
              vessel: f.vessel,
              mode: f.mode ?? undefined, // column default ("ocean") when unshown
              originPort: f.origin_port,
              destinationPort: f.destination_port,
              etd: f.etd,
              eta: f.eta,
              sailedOnBoardDate: f.shipped_on_board_date,
            })
            .returning({ id: schema.shipments.id });
          shipmentId = created.id;
          links.push({ entityType: "shipment", entityId: shipmentId, created: true });
        }

        for (const poNumber of f.referenced_pos.flatMap(splitReferenceNumbers)) {
          const po = await findOrCreatePoByNumber(poNumber);
          await tx
            .insert(schema.shipmentPurchaseOrders)
            .values({ orgId, shipmentId, purchaseOrderId: po.id })
            .onConflictDoNothing();
          links.push({
            entityType: "purchase_order",
            entityId: po.id,
            created: po.created,
          });
        }
        break;
      }

      case "purchase_order": {
        const f = extraction.fields;
        let poId: string;
        const existing = await tx.query.purchaseOrders.findFirst({
          where: and(
            eq(schema.purchaseOrders.orgId, orgId),
            eq(schema.purchaseOrders.poNumber, f.po_number),
          ),
        });
        const headerVendor = await findOrCreateVendor(
          tx,
          orgId,
          f.supplier_name,
        );
        if (existing) {
          poId = existing.id;
          // Stubs created from an entry/shipment's referenced PO numbers
          // carry no header detail; the PO document is authoritative for
          // its own number. Dated/priced header facts overwrite, the
          // supplier fills a gap (a human-entered name is not displaced by
          // an extraction) — the resolved vendor follows the same rule.
          await tx
            .update(schema.purchaseOrders)
            .set({
              orderDate: f.order_date ?? existing.orderDate,
              supplierName: existing.supplierName ?? f.supplier_name,
              vendorId: existing.vendorId ?? headerVendor?.id ?? null,
              currency: f.currency,
              totalAmount: f.total_amount?.toFixed(2) ?? existing.totalAmount,
              updatedAt: new Date(),
            })
            .where(eq(schema.purchaseOrders.id, poId));
          links.push({ entityType: "purchase_order", entityId: poId, created: false });
        } else {
          const [created] = await tx
            .insert(schema.purchaseOrders)
            .values({
              orgId,
              poNumber: f.po_number,
              supplierName: f.supplier_name,
              vendorId: headerVendor?.id ?? null,
              orderDate: f.order_date,
              currency: f.currency,
              totalAmount: f.total_amount?.toFixed(2),
            })
            .returning({ id: schema.purchaseOrders.id });
          poId = created.id;
          links.push({ entityType: "purchase_order", entityId: poId, created: true });
        }

        // PO lines: replace wholesale (the entry-line pattern). This is the
        // grain quote→PO matching and per-SKU history run on; total_price is
        // stored as the document's extended line value (qty × unit).
        await tx
          .delete(schema.purchaseOrderLines)
          .where(eq(schema.purchaseOrderLines.purchaseOrderId, poId));
        if (f.line_items.length > 0) {
          const partIndex = await partIndexBySku(
            f.line_items.map((li) => li.sku),
          );
          await tx.insert(schema.purchaseOrderLines).values(
            f.line_items.map((li) => ({
              orgId,
              purchaseOrderId: poId,
              lineNumber: li.line_number,
              partId: resolveSku(partIndex, li.sku)?.id ?? null,
              sku: li.sku,
              description: li.description,
              countryOfOrigin: toCoo(li.country_of_origin),
              quantity: li.quantity.toFixed(4),
              unitPrice: li.unit_price.toFixed(4),
              totalPrice: (
                Math.round(li.quantity * li.unit_price * 100) / 100
              ).toFixed(2),
            })),
          );
        }

        // With lines on the books, approved quotes waiting on this PO can
        // become official — quotes/service owns those writes; same
        // transaction so the PO never lands without its quote effects.
        await applyQuotesForPo(tx, orgId, poId);
        break;
      }

      case "quote_sheet": {
        const f = extraction.fields;
        // quotes/service is the sole writer of quote tables and of
        // draft-part creation for unknown SKUs; delegate in-transaction.
        // Reprocessing inserts a fresh sheet whose lines auto-supersede the
        // previous RECEIVED lines for the same (part, vendor); approved
        // lines survive machine re-ingestion by design.
        const result = await ingestQuoteSheet(tx, orgId, {
          documentId,
          supplierName: f.supplier_name,
          quoteDate: f.quote_date,
          currency: f.currency,
          validUntil: f.valid_until,
          notes: f.notes,
          lines: f.line_items.map((li) => ({
            lineNumber: li.line_number,
            sku: li.sku,
            description: li.description,
            unitCost: li.unit_cost,
            currency: li.currency,
            countryOfOrigin: li.country_of_origin,
            htsCode: li.hts_code,
            moq: li.moq,
            leadTimeDays: li.lead_time_days,
            unitOfMeasure: li.unit_of_measure,
          })),
        });

        links.push({
          entityType: "quote_sheet",
          entityId: result.sheet.id,
          created: true,
        });
        // Part provenance: created=true only for draft parts this ingest
        // brought into existence; existing quoted parts are references.
        const createdParts = new Set(result.createdPartIds);
        for (const line of result.lines) {
          links.push({
            entityType: "part",
            entityId: line.partId,
            created: createdParts.has(line.partId),
          });
        }
        await adoptEntryLinesForParts(tx, orgId, result.createdPartIds);
        break;
      }

      case "commercial_invoice": {
        const f = extraction.fields;

        // Invoices covering several POs arrive with them packed into the
        // scalar po_number ("8119907E7,8119908E2") — split before matching
        // or the comma string becomes a literal PO row. The invoice row
        // keeps the first as its primary PO; every one gets linked.
        const poIds: string[] = [];
        for (const poNumber of splitReferenceNumbers(f.po_number)) {
          const po = await findOrCreatePoByNumber(poNumber);
          poIds.push(po.id);
          links.push({
            entityType: "purchase_order",
            entityId: po.id,
            created: po.created,
          });
        }
        const poId: string | null = poIds[0] ?? null;

        // Upsert by (org, invoice number); reprocessing replaces the lines
        // wholesale, the same pattern entry line items use. Unlike POs
        // (gap-fill), the invoice document is always authoritative for its
        // own supplier — name and resolved vendor both overwrite.
        const invoiceVendor = await findOrCreateVendor(
          tx,
          orgId,
          f.supplier_name,
        );
        let invoiceId: string;
        const values = {
          purchaseOrderId: poId,
          supplierName: f.supplier_name,
          vendorId: invoiceVendor?.id ?? null,
          invoiceDate: f.invoice_date,
          currency: f.currency,
          totalAmount: f.amount?.toFixed(2) ?? null,
          incoterms: f.incoterms,
        };
        const existing = await tx.query.invoices.findFirst({
          where: and(
            eq(schema.invoices.orgId, orgId),
            eq(schema.invoices.invoiceNumber, f.invoice_number),
          ),
        });
        if (existing) {
          invoiceId = existing.id;
          await tx
            .update(schema.invoices)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(schema.invoices.id, invoiceId));
          links.push({ entityType: "invoice", entityId: invoiceId, created: false });
        } else {
          const [created] = await tx
            .insert(schema.invoices)
            .values({ orgId, invoiceNumber: f.invoice_number, ...values })
            .returning({ id: schema.invoices.id });
          invoiceId = created.id;
          links.push({ entityType: "invoice", entityId: invoiceId, created: true });
        }

        await tx
          .delete(schema.invoiceLineItems)
          .where(eq(schema.invoiceLineItems.invoiceId, invoiceId));
        if (f.line_items.length > 0) {
          const partIndex = await partIndexBySku(
            f.line_items.map((li) => li.sku),
          );

          await tx.insert(schema.invoiceLineItems).values(
            f.line_items.map((li) => ({
              orgId,
              invoiceId,
              lineNumber: li.line_number,
              partId: resolveSku(partIndex, li.sku)?.id ?? null,
              sku: li.sku,
              description: li.description,
              countryOfOrigin: toCoo(li.country_of_origin),
              htsCode: li.hts_code,
              htsCodeDigits: li.hts_code ? normalizeHts(li.hts_code) : null,
              quantity: li.quantity?.toFixed(4) ?? null,
              unitPrice: li.unit_price?.toFixed(4) ?? null,
              totalPrice: li.total_price.toFixed(2),
            })),
          );
        }

        // Direct entry links — the CI is the primary document entries are
        // audited against: (a) entries created by sibling parts of the same
        // packet; (b) entries whose 7501 referenced this invoice number
        // (their entry_invoices rows already point at the stub row this
        // upsert filled in); (c) entries reachable through the shared PO,
        // only when nothing links directly — PO-derived inference must not
        // pollute direct links.
        const touched = new Set<string>();
        for (const siblingEntryId of await siblingEntityIds("entry")) {
          touched.add(siblingEntryId);
        }
        const directRows = await tx.query.entryInvoices.findMany({
          where: eq(schema.entryInvoices.invoiceId, invoiceId),
          columns: { entryId: true },
        });
        const hasDirect = touched.size > 0 || directRows.length > 0;
        for (const row of directRows) touched.add(row.entryId);
        if (!hasDirect && poIds.length > 0) {
          const entryLinks = await tx.query.entryPurchaseOrders.findMany({
            where: inArray(schema.entryPurchaseOrders.purchaseOrderId, poIds),
            columns: { entryId: true },
          });
          for (const el of entryLinks) touched.add(el.entryId);
        }
        for (const touchedEntryId of touched) {
          await linkEntryInvoice(touchedEntryId, invoiceId);
          links.push({
            entityType: "entry",
            entityId: touchedEntryId,
            created: false,
          });
          await auditEntry(tx, orgId, touchedEntryId);
        }
        break;
      }

      case "packing_list": {
        const f = extraction.fields;
        if (f.bill_of_lading) {
          const existing = await tx.query.shipments.findFirst({
            where: and(
              eq(schema.shipments.orgId, orgId),
              eq(schema.shipments.billOfLading, f.bill_of_lading),
            ),
          });
          if (existing) {
            links.push({ entityType: "shipment", entityId: existing.id, created: false });
          }
        }
        break;
      }

      // The packet parent creates no domain records — its children do the
      // work; the manifest itself is the parent's extracted_data.
      case "entry_packet":
        break;

      case "other":
        break;
    }

    if (links.length > 0) {
      const seen = new Set<string>();
      const deduped = links.filter((l) => {
        const key = `${l.entityType}:${l.entityId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await tx
        .insert(schema.documentLinks)
        .values(deduped.map((l) => ({ orgId, documentId, ...l })))
        .onConflictDoNothing();
    }
  });
}

// The SKU→part match above runs at document-processing time only, so a part
// that arrives AFTER its entries (catalog import, manual New SKU, quote-
// created draft) never picks up the lines already on the books — they sit
// with part_id null and the Parts page counts the SKU inactive. This is the
// same linkage run from the other side, called by every part-creation path
// so the entry graph ends up identical whichever side arrived first. Lives
// here because this module is the entry graph's single writer. Touched
// entries are re-audited in the same transaction — the catalog HTS/COO
// comparisons only see lines through this link.
export async function adoptEntryLinesForParts(
  tx: DbClient,
  orgId: string,
  partIds: string[],
): Promise<{ linkedLines: number; auditedEntries: number }> {
  const ids = [...new Set(partIds)];
  if (ids.length === 0) return { linkedLines: 0, auditedEntries: 0 };

  // Chunked: a whole-catalog import passes tens of thousands of ids.
  const partRefs: { id: string; sku: string }[] = [];
  for (let i = 0; i < ids.length; i += 5000) {
    partRefs.push(
      ...(await tx.query.parts.findMany({
        where: and(
          eq(schema.parts.orgId, orgId),
          inArray(schema.parts.id, ids.slice(i, i + 5000)),
        ),
        columns: { id: true, sku: true },
      })),
    );
  }
  const partIndex = buildSkuIndex(partRefs);

  // Orphans match on the normalized key (parts/sku.ts) — same rule as the
  // processing-time lookup, so a line orphaned only by casing heals here.
  const keys = [...partIndex.keys()];
  const orphans: { id: string; entryId: string; sku: string | null }[] = [];
  for (let i = 0; i < keys.length; i += 5000) {
    const chunk = await tx.query.entryLineItems.findMany({
      where: and(
        eq(schema.entryLineItems.orgId, orgId),
        isNull(schema.entryLineItems.partId),
        inArray(skuKeySql(schema.entryLineItems.sku), keys.slice(i, i + 5000)),
      ),
      columns: { id: true, entryId: true, sku: true },
    });
    orphans.push(...chunk);
  }
  if (orphans.length === 0) return { linkedLines: 0, auditedEntries: 0 };

  const lineIdsByPart = new Map<string, string[]>();
  const linkedEntryIds = new Set<string>();
  let linkedLines = 0;
  for (const line of orphans) {
    // Null only for case-twin parts with no exact spelling match — leave
    // those unlinked rather than guess which twin the line means.
    const part = resolveSku(partIndex, line.sku);
    if (part === null) continue;
    const bucket = lineIdsByPart.get(part.id);
    if (bucket) bucket.push(line.id);
    else lineIdsByPart.set(part.id, [line.id]);
    linkedEntryIds.add(line.entryId);
    linkedLines++;
  }
  if (linkedLines === 0) return { linkedLines: 0, auditedEntries: 0 };
  for (const [partId, lineIds] of lineIdsByPart) {
    for (let i = 0; i < lineIds.length; i += 5000) {
      await tx
        .update(schema.entryLineItems)
        .set({ partId })
        .where(inArray(schema.entryLineItems.id, lineIds.slice(i, i + 5000)));
    }
  }

  const entryIds = [...linkedEntryIds];
  for (const entryId of entryIds) {
    await auditEntry(tx, orgId, entryId);
  }
  return { linkedLines, auditedEntries: entryIds.length };
}
