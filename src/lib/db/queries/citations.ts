import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import {
  citationKey,
  type FactCitationMap,
} from "@/lib/documents/citations";

// Read side of fact_citations: where the facts on one 7501 line were read.
// Org-scoped like every request-path query; the map is keyed for the
// ledger's row lookups.

/** Every citation backing a 7501 line and its declared charges. */
export async function getLineCitations(
  lineItemId: string,
): Promise<FactCitationMap> {
  const orgId = await getCurrentOrgId();
  const charges = await db.query.entryLineCharges.findMany({
    where: and(
      eq(schema.entryLineCharges.orgId, orgId),
      eq(schema.entryLineCharges.lineItemId, lineItemId),
    ),
    columns: { id: true },
  });
  const rows = await db
    .select({
      id: schema.factCitations.id,
      entityType: schema.factCitations.entityType,
      entityId: schema.factCitations.entityId,
      field: schema.factCitations.field,
      page: schema.factCitations.page,
      printed: schema.factCitations.printed,
      documentId: schema.factCitations.documentId,
      docType: schema.documents.docType,
    })
    .from(schema.factCitations)
    .innerJoin(
      schema.documents,
      eq(schema.factCitations.documentId, schema.documents.id),
    )
    .where(
      and(
        eq(schema.factCitations.orgId, orgId),
        inArray(schema.factCitations.entityId, [
          lineItemId,
          ...charges.map((c) => c.id),
        ]),
      ),
    );
  const map: FactCitationMap = {};
  for (const row of rows) {
    map[citationKey(row.entityType, row.entityId, row.field)] = {
      id: row.id,
      page: row.page,
      documentId: row.documentId,
      docType: row.docType,
      printed: row.printed,
    };
  }
  return map;
}
