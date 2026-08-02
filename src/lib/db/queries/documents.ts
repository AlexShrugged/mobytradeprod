import "server-only";

import { and, desc, eq, getTableColumns } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import type { DocumentListItem, IntegrationKind } from "@/lib/db/schema";

// Every list/link query excludes raw_extraction: it can be multiple MB of
// provider payload per row and is only read by server-side AI/provenance
// features, never by list views.
const { rawExtraction: strippedRawColumn, ...documentListColumns } =
  getTableColumns(schema.documents);
void strippedRawColumn;

// The documents table's Source column: which intake channel delivered the
// file (manual upload / SFTP / email inbox / ERP). Null on legacy rows.
export type DocumentWithSource = DocumentListItem & {
  sourceName: string | null;
  sourceKind: IntegrationKind | null;
};

export async function getDocuments(): Promise<DocumentWithSource[]> {
  const orgId = await getCurrentOrgId();
  return db
    .select({
      ...documentListColumns,
      sourceName: schema.integrationSources.name,
      sourceKind: schema.integrationSources.kind,
    })
    .from(schema.documents)
    .leftJoin(
      schema.integrationSources,
      eq(schema.documents.sourceId, schema.integrationSources.id),
    )
    .where(eq(schema.documents.orgId, orgId))
    .orderBy(desc(schema.documents.uploadedAt));
}

export type LinkedDocument = { document: DocumentListItem; created: boolean };

// First reader of document_links: the provenance drill-through from a
// domain record back to the paperwork that created or referenced it.
export async function getDocumentsForEntity(
  entityType: (typeof schema.linkedEntityType.enumValues)[number],
  entityId: string,
): Promise<LinkedDocument[]> {
  const orgId = await getCurrentOrgId();
  return db
    .select({ document: documentListColumns, created: schema.documentLinks.created })
    .from(schema.documentLinks)
    .innerJoin(
      schema.documents,
      eq(schema.documentLinks.documentId, schema.documents.id),
    )
    .where(
      and(
        eq(schema.documentLinks.orgId, orgId),
        eq(schema.documentLinks.entityType, entityType),
        eq(schema.documentLinks.entityId, entityId),
      ),
    )
    .orderBy(desc(schema.documents.uploadedAt));
}
