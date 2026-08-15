// Loads everything the analyst may reach for one entry, up front: the exact
// auditable snapshot production audits run on (audit/auditor.ts), every
// linked document WITH its typed extraction (the one read the query layer
// deliberately doesn't offer — raw_extraction stays excluded, it can be
// multiple MB per row), and catalog data for the entry's SKUs. Read-only.
//
// Relative imports + DbClient parameter on purpose — this module runs under
// the tsx eval script and must not touch server-only query modules.

import { and, desc, eq, inArray, or } from "drizzle-orm";

import { loadAuditableSnapshot } from "../audit/auditor";
import * as schema from "../db/schema";
import type { DbClient } from "../duty/reference";
import type {
  BundleAdcvdOrder,
  BundleDocument,
  BundlePart,
  EntryBundle,
} from "./types";

export async function loadEntryBundle(
  db: DbClient,
  orgId: string,
  entryId: string,
): Promise<EntryBundle | null> {
  const snapshot = await loadAuditableSnapshot(db, orgId, entryId);
  if (!snapshot) return null;

  const [shipLinks, poLinks, invLinks] = await Promise.all([
    db.query.entryShipments.findMany({
      where: eq(schema.entryShipments.entryId, entryId),
      columns: { shipmentId: true },
    }),
    db.query.entryPurchaseOrders.findMany({
      where: eq(schema.entryPurchaseOrders.entryId, entryId),
      columns: { purchaseOrderId: true },
    }),
    db.query.entryInvoices.findMany({
      where: eq(schema.entryInvoices.entryId, entryId),
      columns: { invoiceId: true },
    }),
  ]);
  const shipmentIds = shipLinks.map((l) => l.shipmentId);
  const poIds = poLinks.map((l) => l.purchaseOrderId);
  const invoiceIds = invLinks.map((l) => l.invoiceId);

  // Same fan-out shape as getEntryDetail's provenance join, plus the
  // extracted_data column the analyst reads documents through.
  const documentRows = await db
    .select({
      id: schema.documents.id,
      fileName: schema.documents.fileName,
      docType: schema.documents.docType,
      status: schema.documents.status,
      packetRole: schema.documents.packetRole,
      pageRange: schema.documents.pageRange,
      extractedData: schema.documents.extractedData,
      entityType: schema.documentLinks.entityType,
      entityId: schema.documentLinks.entityId,
    })
    .from(schema.documentLinks)
    .innerJoin(
      schema.documents,
      eq(schema.documentLinks.documentId, schema.documents.id),
    )
    .where(
      and(
        eq(schema.documentLinks.orgId, orgId),
        or(
          and(
            eq(schema.documentLinks.entityType, "entry"),
            eq(schema.documentLinks.entityId, entryId),
          ),
          shipmentIds.length
            ? and(
                eq(schema.documentLinks.entityType, "shipment"),
                inArray(schema.documentLinks.entityId, shipmentIds),
              )
            : undefined,
          poIds.length
            ? and(
                eq(schema.documentLinks.entityType, "purchase_order"),
                inArray(schema.documentLinks.entityId, poIds),
              )
            : undefined,
          invoiceIds.length
            ? and(
                eq(schema.documentLinks.entityType, "invoice"),
                inArray(schema.documentLinks.entityId, invoiceIds),
              )
            : undefined,
        ),
      ),
    )
    .orderBy(desc(schema.documents.uploadedAt));

  const documents: BundleDocument[] = [];
  const byId = new Map<string, BundleDocument>();
  for (const row of documentRows) {
    const link = { entityType: row.entityType, entityId: row.entityId };
    const existing = byId.get(row.id);
    if (existing) {
      existing.linkedVia.push(link);
      continue;
    }
    const doc: BundleDocument = {
      id: row.id,
      fileName: row.fileName,
      docType: row.docType,
      status: row.status,
      packetRole: row.packetRole,
      pageRange: row.pageRange,
      linkedVia: [link],
      extractedData: row.extractedData,
    };
    byId.set(row.id, doc);
    documents.push(doc);
  }

  const skus = [
    ...new Set(
      snapshot.auditable.lines
        .map((l) => l.sku)
        .filter((s): s is string => s !== null),
    ),
  ];
  const partsBySku = new Map<string, BundlePart>();
  if (skus.length > 0) {
    const parts = await db.query.parts.findMany({
      where: and(
        eq(schema.parts.orgId, orgId),
        inArray(schema.parts.sku, skus),
      ),
      with: {
        sources: { with: { vendor: true } },
        classifications: true,
      },
    });
    for (const p of parts) {
      partsBySku.set(p.sku, {
        sku: p.sku,
        name: p.name,
        description: p.description,
        status: p.status,
        htsCode: p.htsCode,
        htsCodeProvisional: p.htsCodeProvisional,
        sources: p.sources.map((s) => ({
          vendorName: s.vendor.name,
          countryOfOrigin: s.countryOfOrigin,
          unitCost: s.unitCost,
          validFrom: s.validFrom,
          validTo: s.validTo,
        })),
        classifications: p.classifications.map((c) => ({
          htsCode: c.htsCode,
          validFrom: c.validFrom,
          validTo: c.validTo,
        })),
      });
    }
  }

  // The whole corpus rides along (global reference, a handful of rows) —
  // pre-filtering by the entry's codes would hide exactly the adjacent
  // orders a case-number typo needs checking against.
  const orderRows = await db.query.adcvdOrders.findMany({
    orderBy: (t, { asc }) => [asc(t.caseNumber)],
  });
  const adcvdOrders: BundleAdcvdOrder[] = orderRows.map((o) => ({
    caseNumber: o.caseNumber,
    country: o.country,
    merchandise: o.merchandise,
    scopeSummary: o.scopeSummary,
    htsPrefixes: Array.isArray(o.htsPrefixes)
      ? (o.htsPrefixes as string[])
      : [],
    status: o.status,
    effectiveDate: o.effectiveDate,
    revokedDate: o.revokedDate,
    depositRates: Array.isArray(o.depositRates)
      ? (o.depositRates as { producer: string | null; rate: number }[])
      : [],
    source: o.source,
  }));

  return { orgId, snapshot, documents, partsBySku, adcvdOrders };
}
