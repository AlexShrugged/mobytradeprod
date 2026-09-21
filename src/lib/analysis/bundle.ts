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
import { enabledRules, loadOrgRules, type SuppressionSpec } from "../org-rules";
import { loadResolvedLineParts } from "../parts/line-parts-load";
import { section232Mark } from "../parts/section-232";
import { normalizeSku } from "../parts/sku";
import type {
  BundleAdcvdOrder,
  BundleDocument,
  BundleLinePart,
  BundlePart,
  BundleSection232Catalog,
  BundleSiblingEntry,
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

  // Other entries on this entry's shipments, with declared lines + charges.
  // Goods moving together should carry identical Ch99 treatment; loading the
  // siblings here makes that check deliberate instead of depending on which
  // packet document happened to home onto both entries.
  const siblingEntries: BundleSiblingEntry[] = [];
  // Sibling entry id → its line item ids in line order, so the catalog
  // pass below can hang each sibling line's SKUs on it.
  const siblingLineIds = new Map<string, { entryId: string; ids: string[] }>();
  if (shipmentIds.length > 0) {
    const siblingLinks = await db.query.entryShipments.findMany({
      where: and(
        eq(schema.entryShipments.orgId, orgId),
        inArray(schema.entryShipments.shipmentId, shipmentIds),
      ),
      with: { shipment: true },
    });
    const shipmentsBySibling = new Map<
      string,
      BundleSiblingEntry["sharedShipments"]
    >();
    for (const link of siblingLinks) {
      if (link.entryId === entryId) continue;
      const list = shipmentsBySibling.get(link.entryId) ?? [];
      list.push({
        shipmentNumber: link.shipment.shipmentNumber,
        billOfLading: link.shipment.billOfLading,
        mode: link.shipment.mode,
      });
      shipmentsBySibling.set(link.entryId, list);
    }
    if (shipmentsBySibling.size > 0) {
      const siblingRows = await db.query.entries.findMany({
        where: and(
          eq(schema.entries.orgId, orgId),
          inArray(schema.entries.id, [...shipmentsBySibling.keys()]),
        ),
        with: {
          lineItems: {
            with: { charges: true },
            orderBy: (li, { asc }) => [asc(li.lineNumber)],
          },
        },
        orderBy: (e, { asc }) => [asc(e.entryNumber)],
      });
      for (const sibling of siblingRows) {
        siblingLineIds.set(sibling.entryNumber, {
          entryId: sibling.id,
          ids: sibling.lineItems.map((li) => li.id),
        });
        siblingEntries.push({
          entryNumber: sibling.entryNumber,
          entryDate: sibling.entryDate,
          entryType: sibling.entryType,
          totalEnteredValue: sibling.totalEnteredValue,
          totalDuty: sibling.totalDuty,
          sharedShipments: shipmentsBySibling.get(sibling.id) ?? [],
          lines: sibling.lineItems.map((li) => ({
            lineNumber: li.lineNumber,
            sku: li.sku,
            description: li.description,
            htsCode: li.htsCode,
            spi: li.spi,
            countryOfOrigin: li.countryOfOrigin,
            supplierName: li.supplierName,
            quantity: li.quantity,
            enteredValue: li.enteredValue,
            charges: li.charges.map((c) => ({
              chargeType: c.chargeType,
              htsCode: c.htsCode,
              rate: c.rate,
              amount: c.amount,
            })),
          })),
        });
      }
    }
  }

  // The catalog SKUs in the orbit of this entry and its siblings: declared
  // on a 7501 line, named by a broker tariff code sheet, inferred from the
  // commercial invoice (parts/line-parts.ts), plus every line of the
  // entries' invoices — real broker 7501s print no part number, so without
  // the invoice the catalog would be invisible here.
  const orbitEntryIds = [
    entryId,
    ...[...siblingLineIds.values()].map((s) => s.entryId),
  ];
  const resolvedLineParts = await loadResolvedLineParts(db, orbitEntryIds);
  const orbitInvoiceLinks = await db.query.entryInvoices.findMany({
    where: and(
      eq(schema.entryInvoices.orgId, orgId),
      inArray(schema.entryInvoices.entryId, orbitEntryIds),
    ),
    columns: { entryId: true, invoiceId: true },
  });
  const orbitInvoiceIds = [...new Set(orbitInvoiceLinks.map((l) => l.invoiceId))];
  const orbitInvoiceLines = orbitInvoiceIds.length
    ? await db.query.invoiceLineItems.findMany({
        where: inArray(schema.invoiceLineItems.invoiceId, orbitInvoiceIds),
        columns: { invoiceId: true, sku: true, partId: true },
      })
    : [];

  const declaredSkus = [
    ...new Set(
      snapshot.auditable.lines
        .map((l) => l.sku)
        .filter((s): s is string => s !== null),
    ),
  ];
  const orbitPartIds = [
    ...new Set(
      [
        ...[...resolvedLineParts.values()].flat().map((p) => p.partId),
        ...orbitInvoiceLines.map((l) => l.partId),
      ].filter((id): id is string => id !== null),
    ),
  ];
  const partRows =
    declaredSkus.length + orbitPartIds.length > 0
      ? await db.query.parts.findMany({
          where: and(
            eq(schema.parts.orgId, orgId),
            or(
              declaredSkus.length
                ? inArray(schema.parts.sku, declaredSkus)
                : undefined,
              orbitPartIds.length
                ? inArray(schema.parts.id, orbitPartIds)
                : undefined,
            ),
          ),
          with: {
            sources: { with: { vendor: true } },
            classifications: true,
          },
          orderBy: (p, { asc }) => [asc(p.sku)],
        })
      : [];

  const markByPartId = new Map(
    partRows.map((p) => [p.id, section232Mark(p.section232)]),
  );
  const skuByPartId = new Map(partRows.map((p) => [p.id, p.sku]));
  const markBySkuKey = new Map(
    partRows.map((p) => [normalizeSku(p.sku), section232Mark(p.section232)]),
  );

  // Only SKUs this entry itself carries answer get_part; sibling SKUs
  // surface through get_sibling_entries.
  const ownPartIds = new Set(
    [
      ...snapshot.auditable.lines.flatMap(
        (l) => resolvedLineParts.get(l.id) ?? [],
      ),
      ...orbitInvoiceLines.filter((il) =>
        orbitInvoiceLinks.some(
          (link) => link.entryId === entryId && link.invoiceId === il.invoiceId,
        ),
      ),
    ]
      .map((p) => p.partId)
      .filter((id): id is string => id !== null),
  );
  const partsBySku = new Map<string, BundlePart>();
  for (const p of partRows) {
    if (!ownPartIds.has(p.id) && !declaredSkus.includes(p.sku)) continue;
    partsBySku.set(p.sku, {
      sku: p.sku,
      name: p.name,
      description: p.description,
      status: p.status,
      htsCode: p.htsCode,
      htsCodeProvisional: p.htsCodeProvisional,
      section232: section232Mark(p.section232),
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

  const linePartsOf = (lineId: string): BundleLinePart[] =>
    (resolvedLineParts.get(lineId) ?? []).map((p) => ({
      sku: p.sku,
      source: p.source,
      section232:
        (p.partId ? markByPartId.get(p.partId) : undefined) ??
        markBySkuKey.get(normalizeSku(p.sku)) ??
        null,
    }));

  /** Marks across one entry's orbit; null when the importer marked none. */
  const catalogOf = (
    id: string,
    lineIds: string[],
  ): BundleSection232Catalog | null => {
    const partIds = new Set<string>();
    for (const lineId of lineIds) {
      for (const p of resolvedLineParts.get(lineId) ?? []) {
        if (p.partId) partIds.add(p.partId);
      }
    }
    const invoiceIds = new Set(
      orbitInvoiceLinks.filter((l) => l.entryId === id).map((l) => l.invoiceId),
    );
    for (const il of orbitInvoiceLines) {
      if (il.partId && invoiceIds.has(il.invoiceId)) partIds.add(il.partId);
    }
    const applies: string[] = [];
    const doesNotApply: string[] = [];
    let unmarked = 0;
    for (const partId of partIds) {
      const sku = skuByPartId.get(partId);
      if (sku === undefined) continue;
      const mark = markByPartId.get(partId) ?? null;
      if (mark === "applies") applies.push(sku);
      else if (mark === "does_not_apply") doesNotApply.push(sku);
      else unmarked++;
    }
    if (applies.length + doesNotApply.length === 0) return null;
    return {
      applies: applies.sort(),
      doesNotApply: doesNotApply.sort(),
      unmarked,
    };
  };

  const lineParts = new Map<number, BundleLinePart[]>();
  for (const line of snapshot.auditable.lines) {
    const parts = linePartsOf(line.id);
    if (parts.length > 0) lineParts.set(line.lineNumber, parts);
  }
  const section232Catalog = catalogOf(
    entryId,
    snapshot.auditable.lines.map((l) => l.id),
  );

  for (const sibling of siblingEntries) {
    const ref = siblingLineIds.get(sibling.entryNumber);
    if (!ref) continue;
    sibling.lines.forEach((line, i) => {
      const parts = linePartsOf(ref.ids[i]);
      if (parts.length > 0) line.parts = parts;
    });
    const catalog = catalogOf(ref.entryId, ref.ids);
    if (catalog) sibling.section232Catalog = catalog;
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

  const orgRules = enabledRules(await loadOrgRules(db, orgId)).map((r) => ({
    id: r.id,
    text: r.text,
    suppression: r.suppression as SuppressionSpec | null,
  }));

  return {
    orgId,
    snapshot,
    documents,
    siblingEntries,
    partsBySku,
    lineParts,
    section232Catalog,
    adcvdOrders,
    orgRules,
  };
}
