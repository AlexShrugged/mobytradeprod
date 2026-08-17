import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { processDocumentRow } from "@/lib/processing/run";

// Real extraction (parse + two extracts) can take minutes on large scans.
export const maxDuration = 800;

// raw_extraction can be multiple MB of provider payload — never send it to
// the client; it is served on demand by future AI/provenance features.
function withoutRaw<T extends { rawExtraction: unknown }>(doc: T) {
  const { rawExtraction, ...rest } = doc;
  void rawExtraction;
  return rest;
}

// Reprocessing is this same route called again: failed docs retry (attempt
// 2 lets the stub succeed), processed docs re-extract and the linker's
// wholesale-replace/upsert semantics keep records from duplicating.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const orgId = await getCurrentOrgId();

  const doc = await db.query.documents.findFirst({
    where: and(
      eq(schema.documents.id, documentId),
      eq(schema.documents.orgId, orgId),
    ),
  });
  if (!doc) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  // Catalog imports are applied by the Parts page importer at upload time —
  // there is no document processor for them, and a reprocess would clobber
  // the import summary in extracted_data. Re-import the file instead.
  if (doc.docType === "part_catalog") {
    return NextResponse.json(
      { error: "Part catalog imports re-apply from the Parts page, not here." },
      { status: 409 },
    );
  }

  const outcome = await processDocumentRow(doc);
  if (!outcome.claimed) {
    return NextResponse.json(
      { error: "Document is already being processed." },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { document: withoutRaw(outcome.document) },
    { status: outcome.ok ? 200 : 422 },
  );
}
