import "server-only";

import {
  and,
  desc,
  eq,
  getTableColumns,
  ilike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import type { DocumentListItem, IntegrationKind } from "@/lib/db/schema";

// Every list/link query excludes raw_extraction: it can be multiple MB of
// provider payload per row and is only read by server-side AI/provenance
// features, never by list views.
const { rawExtraction: strippedRawColumn, ...documentListColumns } =
  getTableColumns(schema.documents);
void strippedRawColumn;

// Derived on read, never stored: a parent row whose bytes match an earlier
// parent in the org points at that original (the upload routes refuse new
// duplicates; these are the ones that got in before hashing existed or
// raced the check). Children never carry a hash, so they never match.
const duplicateOfWhere = sql`
  d2.org_id = ${schema.documents.orgId}
  and d2.content_hash = ${schema.documents.contentHash}
  and d2.parent_document_id is null
  and ${schema.documents.parentDocumentId} is null
  and (d2.uploaded_at, d2.id) < (${schema.documents.uploadedAt}, ${schema.documents.id})`;
const duplicateColumns = {
  duplicateOfId: sql<
    string | null
  >`(select d2.id from documents d2 where ${duplicateOfWhere} order by d2.uploaded_at, d2.id limit 1)`.as(
    "duplicate_of_id",
  ),
  duplicateOfName: sql<
    string | null
  >`(select d2.file_name from documents d2 where ${duplicateOfWhere} order by d2.uploaded_at, d2.id limit 1)`.as(
    "duplicate_of_name",
  ),
};

// The documents table's Source column: which intake channel delivered the
// file (manual upload / SFTP / email inbox / ERP). Null on legacy rows.
export type DocumentWithSource = DocumentListItem & {
  sourceName: string | null;
  sourceKind: IntegrationKind | null;
  /** The earlier document with identical bytes, when this row is a duplicate. */
  duplicateOfId: string | null;
  duplicateOfName: string | null;
};

export async function getDocuments(): Promise<DocumentWithSource[]> {
  const orgId = await getCurrentOrgId();
  return db
    .select({
      ...documentListColumns,
      sourceName: schema.integrationSources.name,
      sourceKind: schema.integrationSources.kind,
      ...duplicateColumns,
    })
    .from(schema.documents)
    .leftJoin(
      schema.integrationSources,
      eq(schema.documents.sourceId, schema.integrationSources.id),
    )
    .where(eq(schema.documents.orgId, orgId))
    .orderBy(desc(schema.documents.uploadedAt));
}

function documentsSearchWhere(q: string | null | undefined): SQL | undefined {
  const trimmed = q?.trim();
  if (!trimmed) return undefined;
  const pattern = `%${trimmed}%`;
  // docType matches on the enum value ("commercial_invoice"), so typing
  // "invoice" or "7501" narrows by kind without a label join.
  return or(
    ilike(schema.documents.fileName, pattern),
    sql`${schema.documents.docType}::text ilike ${pattern}`,
  );
}

export type DocumentsPageResult = {
  rows: DocumentWithSource[];
  /** All documents in the org, filter-independent. */
  totalCount: number;
  /** Documents matching the search — drives the page count. */
  filteredCount: number;
  /** Effective page after clamping to the last page. */
  page: number;
};

// The Data page's window: search + limit/offset over uploadedAt-desc order.
// Packet children paginate as plain rows — the table regroups whatever
// children share a page with their parent and renders strays as roots.
export async function getDocumentsPage(opts: {
  page: number;
  per: number;
  q?: string | null;
}): Promise<DocumentsPageResult> {
  const orgId = await getCurrentOrgId();
  const searchWhere = documentsSearchWhere(opts.q);
  const where = and(eq(schema.documents.orgId, orgId), searchWhere);

  const [totalCount, filteredRaw] = await Promise.all([
    db.$count(schema.documents, eq(schema.documents.orgId, orgId)),
    searchWhere ? db.$count(schema.documents, where) : Promise.resolve(-1), // filled from totalCount below
  ]);
  const filteredCount = filteredRaw === -1 ? totalCount : filteredRaw;

  const page = Math.min(
    Math.max(1, opts.page),
    Math.max(1, Math.ceil(filteredCount / opts.per)),
  );

  const rows = await db
    .select({
      ...documentListColumns,
      sourceName: schema.integrationSources.name,
      sourceKind: schema.integrationSources.kind,
      ...duplicateColumns,
    })
    .from(schema.documents)
    .leftJoin(
      schema.integrationSources,
      eq(schema.documents.sourceId, schema.integrationSources.id),
    )
    .where(where)
    .orderBy(desc(schema.documents.uploadedAt), desc(schema.documents.id))
    .limit(opts.per)
    .offset((page - 1) * opts.per);

  return { rows, totalCount, filteredCount, page };
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
    .select({
      document: documentListColumns,
      created: schema.documentLinks.created,
    })
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
