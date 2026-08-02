import { and, eq, inArray } from "drizzle-orm";

import { auditEntry } from "@/lib/audit/auditor";
import { db, schema } from "@/lib/db";
import { normalizeHts } from "@/lib/duty/calculator";
import { applyQuotesForPo, ingestQuoteSheet } from "@/lib/quotes/service";
import { normalizeEntryNumber } from "@/lib/refunds";
import type { EntryLineItemExtraction, ExtractionResult } from "./types";

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
// shipments, POs + PO lines, invoices, refund claims, document_links); the
// quote tables belong to quotes/service.ts, which the quote_sheet case
// delegates into IN the same transaction.
export async function linkExtraction(
  orgId: string,
  documentId: string,
  extraction: ExtractionResult,
): Promise<void> {
  await db.transaction(async (tx) => {
    const links: { entityType: LinkedEntity; entityId: string; created: boolean }[] = [];

    const findOrCreateShipmentByBol = async (bol: string) => {
      const existing = await tx.query.shipments.findFirst({
        where: and(
          eq(schema.shipments.orgId, orgId),
          eq(schema.shipments.billOfLading, bol),
        ),
      });
      if (existing) return { id: existing.id, created: false };
      const [created] = await tx
        .insert(schema.shipments)
        .values({
          orgId,
          shipmentNumber: `SHP-${bol}`,
          billOfLading: bol,
          status: "booked",
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
        .values({ orgId, poNumber, status: "open" })
        .returning({ id: schema.purchaseOrders.id });
      return { id: created.id, created: true };
    };

    // (org, sku) → part id for a batch of extracted SKUs, one inArray query.
    const partIdsBySku = async (rawSkus: (string | null)[]) => {
      const skus = [
        ...new Set(rawSkus.filter((s): s is string => s !== null)),
      ];
      const matched = skus.length
        ? await tx.query.parts.findMany({
            where: and(
              eq(schema.parts.orgId, orgId),
              inArray(schema.parts.sku, skus),
            ),
            columns: { id: true, sku: true },
          })
        : [];
      return new Map(matched.map((p) => [p.sku, p.id]));
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
              status: "draft",
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
        for (const poNumber of f.referenced_pos) {
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

        // Line items + declared charges: replace wholesale. Charges cascade
        // with their lines; audit alerts survive via set-null and re-attach
        // by alert_key on the next audit pass.
        if (f.line_items.length > 0) {
          const partIdBySku = await partIdsBySku(
            f.line_items.map((li) => li.sku),
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
                partId: li.sku ? (partIdBySku.get(li.sku) ?? null) : null,
                sku: li.sku,
                description: li.description,
                htsCode: li.hts_code,
                htsCodeDigits: normalizeHts(li.hts_code),
                countryOfOrigin: li.country_of_origin,
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

        await auditEntry(tx, orgId, entryId);
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
        const existing = await tx.query.shipments.findFirst({
          where: and(
            eq(schema.shipments.orgId, orgId),
            eq(schema.shipments.billOfLading, f.bill_of_lading),
          ),
        });
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
              originPort: f.origin_port,
              destinationPort: f.destination_port,
              etd: f.etd,
              eta: f.eta,
              sailedOnBoardDate: f.shipped_on_board_date,
              status: "booked",
            })
            .returning({ id: schema.shipments.id });
          shipmentId = created.id;
          links.push({ entityType: "shipment", entityId: shipmentId, created: true });
        }

        for (const poNumber of f.referenced_pos) {
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
        if (existing) {
          poId = existing.id;
          // Stubs created from an entry/shipment's referenced PO numbers
          // carry no header detail; the PO document is authoritative for
          // its own number. Dated/priced header facts overwrite, the
          // supplier fills a gap (a human-entered name is not displaced by
          // an extraction).
          await tx
            .update(schema.purchaseOrders)
            .set({
              orderDate: f.order_date ?? existing.orderDate,
              supplierName: existing.supplierName ?? f.supplier_name,
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
              orderDate: f.order_date,
              currency: f.currency,
              totalAmount: f.total_amount?.toFixed(2),
              status: "open",
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
          const partIdBySku = await partIdsBySku(
            f.line_items.map((li) => li.sku),
          );
          await tx.insert(schema.purchaseOrderLines).values(
            f.line_items.map((li) => ({
              orgId,
              purchaseOrderId: poId,
              lineNumber: li.line_number,
              partId: partIdBySku.get(li.sku) ?? null,
              sku: li.sku,
              description: li.description,
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
        // previous RECEIVED lines for the same (part, supplier); approved
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
        break;
      }

      case "commercial_invoice": {
        const f = extraction.fields;

        let poId: string | null = null;
        if (f.po_number) {
          const po = await findOrCreatePoByNumber(f.po_number);
          poId = po.id;
          links.push({
            entityType: "purchase_order",
            entityId: po.id,
            created: po.created,
          });
        }

        // Upsert by (org, invoice number); reprocessing replaces the lines
        // wholesale, the same pattern entry line items use.
        let invoiceId: string;
        const values = {
          purchaseOrderId: poId,
          supplierName: f.supplier_name,
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
          const partIdBySku = await partIdsBySku(
            f.line_items.map((li) => li.sku),
          );

          await tx.insert(schema.invoiceLineItems).values(
            f.line_items.map((li) => ({
              orgId,
              invoiceId,
              lineNumber: li.line_number,
              partId: li.sku ? (partIdBySku.get(li.sku) ?? null) : null,
              sku: li.sku,
              description: li.description,
              quantity: li.quantity?.toFixed(4) ?? null,
              unitPrice: li.unit_price?.toFixed(4) ?? null,
              totalPrice: li.total_price.toFixed(2),
            })),
          );
        }

        // Invoice values feed the entry-vs-invoice audit rule; re-audit
        // every entry that reaches this invoice through the linked PO.
        if (poId) {
          const entryLinks = await tx.query.entryPurchaseOrders.findMany({
            where: eq(schema.entryPurchaseOrders.purchaseOrderId, poId),
            columns: { entryId: true },
          });
          for (const el of entryLinks) {
            await auditEntry(tx, orgId, el.entryId);
          }
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
