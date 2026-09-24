// Backfill fact_citations for rows written before provenance was persisted
// (migration 0032). Every Reducto-processed 7501 and commercial invoice
// keeps its cited extract response in raw_extraction, so no Reducto credit
// is spent: the payload is re-mapped with today's mapper, and each citation
// is planned onto the existing row whose stored value still equals the
// re-mapped one (documents/citation-backfill.ts — a scrubbed SKU, a blanked
// quantity or an older mapper's output is skipped, never cited wrongly).
// Documents apply oldest first, so an entry re-filed by a newer 7501 ends
// up cited from the newer one.
//
//   DATABASE_URL=... npx tsx scripts/backfill-citations.ts                 # dry run
//   DATABASE_URL=... npx tsx scripts/backfill-citations.ts --apply
//   DATABASE_URL=... npx tsx scripts/backfill-citations.ts --org <orgs.id> --verbose
//   DATABASE_URL=... npx tsx scripts/backfill-citations.ts --doc <documents.id> --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "../src/lib/db";
import {
  planEntryCitations,
  planInvoiceCitations,
  type BackfillPlan,
  type StoredEntry,
  type StoredInvoice,
} from "../src/lib/documents/citation-backfill";
import { mapExtractWithCitations } from "../src/lib/processing/reducto/map";
import type { RawExtraction } from "../src/lib/processing/types";

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function loadEntry(
  orgId: string,
  entryNumber: string,
): Promise<StoredEntry | null> {
  const entry = await db.query.entries.findFirst({
    where: and(
      eq(schema.entries.orgId, orgId),
      eq(schema.entries.entryNumber, entryNumber),
    ),
    columns: {
      id: true,
      entryNumber: true,
      entryDate: true,
      portOfEntry: true,
      entryType: true,
      importerOfRecord: true,
      totalEnteredValue: true,
      totalDuty: true,
      mpfAmount: true,
      hmfAmount: true,
    },
  });
  if (!entry) return null;
  const lines = await db.query.entryLineItems.findMany({
    where: eq(schema.entryLineItems.entryId, entry.id),
    columns: {
      id: true,
      lineNumber: true,
      sku: true,
      description: true,
      htsCode: true,
      spi: true,
      countryOfOrigin: true,
      supplierName: true,
      quantity: true,
      quantityUnit: true,
      unitValue: true,
      enteredValue: true,
    },
    orderBy: [asc(schema.entryLineItems.lineNumber)],
  });
  const charges = lines.length
    ? await db.query.entryLineCharges.findMany({
        where: inArray(
          schema.entryLineCharges.lineItemId,
          lines.map((l) => l.id),
        ),
        columns: {
          id: true,
          lineItemId: true,
          chargeType: true,
          htsCode: true,
          rate: true,
          amount: true,
        },
        // uuidv7 ids sort in insertion order — the position the linker
        // wrote each charge at.
        orderBy: [asc(schema.entryLineCharges.id)],
      })
    : [];
  return {
    ...entry,
    lines: lines.map((l) => ({
      ...l,
      charges: charges
        .filter((c) => c.lineItemId === l.id)
        .map((c) => ({
          id: c.id,
          chargeType: c.chargeType,
          htsCode: c.htsCode,
          rate: c.rate,
          amount: c.amount,
        })),
    })),
  };
}

async function loadInvoice(
  orgId: string,
  invoiceNumber: string,
): Promise<StoredInvoice | null> {
  const invoice = await db.query.invoices.findFirst({
    where: and(
      eq(schema.invoices.orgId, orgId),
      eq(schema.invoices.invoiceNumber, invoiceNumber),
    ),
    columns: {
      id: true,
      invoiceNumber: true,
      supplierName: true,
      invoiceDate: true,
      currency: true,
      totalAmount: true,
      subtotal: true,
      incoterms: true,
    },
  });
  if (!invoice) return null;
  const lines = await db.query.invoiceLineItems.findMany({
    where: eq(schema.invoiceLineItems.invoiceId, invoice.id),
    columns: {
      id: true,
      lineNumber: true,
      sku: true,
      description: true,
      countryOfOrigin: true,
      htsCode: true,
      quantity: true,
      quantityUnit: true,
      unitPrice: true,
      totalPrice: true,
    },
    orderBy: [asc(schema.invoiceLineItems.lineNumber)],
  });
  return { ...invoice, lines };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const verbose = process.argv.includes("--verbose");
  const onlyDoc = argOf("--doc");
  const onlyOrg = argOf("--org");
  const limit = Number(argOf("--limit") ?? 0);

  const docs = await db.query.documents.findMany({
    where: and(
      inArray(schema.documents.docType, ["port_entry", "commercial_invoice"]),
      eq(schema.documents.status, "processed"),
      eq(schema.documents.processedBy, "reducto"),
      onlyDoc ? eq(schema.documents.id, onlyDoc) : undefined,
      onlyOrg ? eq(schema.documents.orgId, onlyOrg) : undefined,
    ),
    columns: {
      id: true,
      orgId: true,
      fileName: true,
      docType: true,
      pageRange: true,
      processedAt: true,
    },
    orderBy: [asc(schema.documents.processedAt)],
    ...(limit > 0 ? { limit } : {}),
  });
  console.log(
    `${docs.length} Reducto-processed 7501/invoice document(s)${apply ? "" : " — dry run"}`,
  );

  const totals = {
    docs: 0,
    noPayload: 0,
    noRow: 0,
    mapFailed: 0,
    planned: 0,
    skipped: 0,
    applied: 0,
  };
  for (const d of docs) {
    totals.docs++;
    // One row at a time: raw_extraction runs to megabytes per document.
    const full = await db.query.documents.findFirst({
      where: eq(schema.documents.id, d.id),
      columns: { rawExtraction: true },
    });
    const raw = (full?.rawExtraction ?? null) as RawExtraction | null;
    const response = raw?.extract?.response;
    if (!response) {
      totals.noPayload++;
      continue;
    }
    if (d.docType !== "port_entry" && d.docType !== "commercial_invoice") {
      continue;
    }
    let mapped: ReturnType<typeof mapExtractWithCitations>;
    try {
      mapped = mapExtractWithCitations(d.docType, response, {
        pageRange: d.pageRange,
      });
    } catch (err) {
      totals.mapFailed++;
      console.log(
        `  ✗ ${d.fileName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!mapped.citations) continue;

    let plan: BackfillPlan | null = null;
    if (mapped.extraction.docType === "port_entry") {
      const stored = await loadEntry(
        d.orgId,
        mapped.extraction.fields.entry_number,
      );
      if (stored) {
        plan = planEntryCitations(
          mapped.extraction.fields,
          mapped.citations,
          stored,
        );
      }
    } else if (mapped.extraction.docType === "commercial_invoice") {
      const stored = await loadInvoice(
        d.orgId,
        mapped.extraction.fields.invoice_number,
      );
      if (stored) {
        plan = planInvoiceCitations(
          mapped.extraction.fields,
          mapped.citations,
          stored,
        );
      }
    }
    if (!plan) {
      totals.noRow++;
      if (verbose) console.log(`  – ${d.fileName}: no stored row`);
      continue;
    }
    totals.planned += plan.rows.length;
    totals.skipped += plan.skipped.length;
    console.log(
      `  ${d.fileName}: ${plan.rows.length} citation(s), ${plan.skipped.length} skipped`,
    );
    if (verbose) {
      for (const reason of plan.skipped.slice(0, 8)) console.log(`      ${reason}`);
    }
    if (!apply || plan.rows.length === 0) continue;

    await db.transaction(async (tx) => {
      await tx
        .delete(schema.factCitations)
        .where(eq(schema.factCitations.documentId, d.id));
      await tx
        .insert(schema.factCitations)
        .values(
          plan.rows.map((r) => ({ orgId: d.orgId, documentId: d.id, ...r })),
        )
        .onConflictDoUpdate({
          target: [
            schema.factCitations.entityType,
            schema.factCitations.entityId,
            schema.factCitations.field,
          ],
          set: {
            documentId: d.id,
            page: sql`excluded.page`,
            boxes: sql`excluded.boxes`,
            printed: sql`excluded.printed`,
            createdAt: new Date(),
          },
        });
    });
    totals.applied += plan.rows.length;
  }

  console.log(
    `\n${totals.docs} document(s): ${totals.planned} citation(s) planned, ${totals.skipped} field(s) skipped, ` +
      `${totals.noPayload} without a cited payload, ${totals.noRow} without a stored row, ${totals.mapFailed} failed to map` +
      (apply ? `; ${totals.applied} written` : "; nothing written (dry run)"),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
