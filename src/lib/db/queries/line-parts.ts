import "server-only";

import { inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  resolveLineParts,
  type LinePartInvoiceLineInput,
  type ResolvedLinePart,
} from "@/lib/parts/line-parts";

// Loads the inputs for parts/line-parts.ts and resolves per entry: which
// catalog parts sit behind each 7501 line. Derived on read (doctrine) —
// only the tariff-sheet rows it reads are stored facts.
//
// Invoice-derived inference only draws on invoices mapping to exactly ONE
// entry, the same gate the CI money rules use: a multi-entry invoice's
// lines can't be attributed to one entry's lines without guessing.
export async function getResolvedLinePartsForEntries(
  entryIds: string[],
): Promise<Map<string, ResolvedLinePart[]>> {
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return new Map();

  const [lines, sheetRows, invoiceLinks] = await Promise.all([
    db.query.entryLineItems.findMany({
      where: inArray(schema.entryLineItems.entryId, ids),
      columns: {
        id: true,
        entryId: true,
        lineNumber: true,
        sku: true,
        partId: true,
        htsCodeDigits: true,
      },
    }),
    db.query.entryLineParts.findMany({
      where: inArray(schema.entryLineParts.entryId, ids),
      columns: { entryId: true, lineNumber: true, sku: true, partId: true },
    }),
    db.query.entryInvoices.findMany({
      where: inArray(schema.entryInvoices.entryId, ids),
      columns: { entryId: true, invoiceId: true },
    }),
  ]);

  // Count each invoice's entries across ALL its links, not just the ones in
  // this id set — an invoice shared with an out-of-scope entry is still
  // multi-entry.
  const invoiceIds = [...new Set(invoiceLinks.map((l) => l.invoiceId))];
  const allLinks = invoiceIds.length
    ? await db.query.entryInvoices.findMany({
        where: inArray(schema.entryInvoices.invoiceId, invoiceIds),
        columns: { entryId: true, invoiceId: true },
      })
    : [];
  const entryCountByInvoice = new Map<string, Set<string>>();
  for (const l of allLinks) {
    let set = entryCountByInvoice.get(l.invoiceId);
    if (!set) entryCountByInvoice.set(l.invoiceId, (set = new Set()));
    set.add(l.entryId);
  }
  const singleEntryInvoiceIds = invoiceIds.filter(
    (id) => entryCountByInvoice.get(id)?.size === 1,
  );

  const invoiceLines = singleEntryInvoiceIds.length
    ? await db.query.invoiceLineItems.findMany({
        where: inArray(schema.invoiceLineItems.invoiceId, singleEntryInvoiceIds),
        columns: {
          invoiceId: true,
          sku: true,
          partId: true,
          htsCodeDigits: true,
        },
      })
    : [];

  const entryByInvoice = new Map(
    singleEntryInvoiceIds.map((id) => [
      id,
      [...(entryCountByInvoice.get(id) ?? [])][0],
    ]),
  );

  const out = new Map<string, ResolvedLinePart[]>();
  for (const entryId of ids) {
    const entryInvoiceLines: LinePartInvoiceLineInput[] = invoiceLines.filter(
      (il) => entryByInvoice.get(il.invoiceId) === entryId,
    );
    const resolved = resolveLineParts(
      lines.filter((l) => l.entryId === entryId),
      sheetRows.filter((r) => r.entryId === entryId),
      entryInvoiceLines,
    );
    for (const [lineId, parts] of resolved) out.set(lineId, parts);
  }
  return out;
}
