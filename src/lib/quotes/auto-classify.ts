// A quote-created SKU arrives with no HTS code — only the supplier's claim,
// which is reference only. Running the classifier right away gives it
// potential codes (ranked candidates, a provisional pick when the run is
// certain) so its quotes can be priced to a landed cost before anyone
// commits a code. The model call runs OUTSIDE the ingest transaction
// (classifyPart owns its own boundary), after the response where a route
// can arrange that; a classifier failure is logged per part and never
// fails the quote.

import { and, eq, inArray } from "drizzle-orm";

import { classifyPart } from "../classification/service";
import type { DbClient } from "../db";
import * as schema from "../db/schema";

export type AutoClassifySummary = {
  classified: number;
  skipped: number;
  failed: number;
};

export async function classifyQuoteCreatedParts(
  db: DbClient,
  orgId: string,
  partIds: string[],
): Promise<AutoClassifySummary> {
  const summary: AutoClassifySummary = { classified: 0, skipped: 0, failed: 0 };
  const ids = [...new Set(partIds)];
  if (ids.length === 0) return summary;

  const [parts, runs] = await Promise.all([
    db.query.parts.findMany({
      where: and(eq(schema.parts.orgId, orgId), inArray(schema.parts.id, ids)),
      columns: { id: true, htsCode: true },
    }),
    db
      .selectDistinct({ partId: schema.htsClassifications.partId })
      .from(schema.htsClassifications)
      .where(inArray(schema.htsClassifications.partId, ids)),
  ]);
  const alreadyRun = new Set(runs.map((r) => r.partId));

  for (const part of parts) {
    // A code (manual, imported) or an earlier run means the part already
    // has its potential codes — reprocessing a sheet never re-runs.
    if (part.htsCode !== null || alreadyRun.has(part.id)) {
      summary.skipped += 1;
      continue;
    }
    try {
      await classifyPart(db, orgId, part.id);
      summary.classified += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`auto-classification of part ${part.id} failed:`, err);
    }
  }
  return summary;
}

/** The draft parts a processed quote-sheet document brought into existence
 *  (quote_lines.part_created under a sheet filed from that document). */
export async function findPartsCreatedByDocument(
  db: DbClient,
  orgId: string,
  documentId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ partId: schema.quoteLines.partId })
    .from(schema.quoteLines)
    .innerJoin(
      schema.quoteSheets,
      eq(schema.quoteLines.quoteSheetId, schema.quoteSheets.id),
    )
    .where(
      and(
        eq(schema.quoteLines.orgId, orgId),
        eq(schema.quoteSheets.documentId, documentId),
        eq(schema.quoteLines.partCreated, true),
      ),
    );
  return rows.map((r) => r.partId);
}
