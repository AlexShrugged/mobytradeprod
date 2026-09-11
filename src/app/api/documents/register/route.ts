import { NextResponse } from "next/server";
import { del, head } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { findDuplicateDocument, sha256Hex } from "@/lib/documents/content-hash";
import type { DuplicateUpload } from "@/lib/documents/duplicates";
import { resolveSourceId } from "@/lib/documents/source";
import { UPLOAD_KEY_RE } from "@/lib/documents/upload-key";
import { getCurrentOrgId } from "@/lib/org";
import { inferDocType } from "@/lib/processing";
import { getFileStore } from "@/lib/storage";

const bodySchema = z.object({
  uploads: z
    .array(
      z.object({
        storageKey: z.string(),
        fileName: z.string().min(1),
        mimeType: z.string().optional(),
      }),
    )
    .min(1),
  sourceId: z.uuid().optional(),
});

// Completion path for client-direct blob uploads: the dropzone uploads
// straight to Vercel Blob (via the upload-token route), then registers the
// results here to create the document rows. Sizes come from head(), never
// from the client, and so does the content hash: the bytes are read back
// from the store and hashed here, so a client can neither forge a match
// nor slip past one. A file identical to a document already on file (any
// status — a failed twin is reprocessed, not re-uploaded) registers no row:
// it is reported in `duplicates`, its orphaned blob is deleted, and the
// response is 409 only when nothing in the batch registered.
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  const orgId = await getCurrentOrgId();

  const resolved = await resolveSourceId(orgId, parsed.data.sourceId ?? null);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const { sourceId } = resolved;

  const store = getFileStore();
  const created = [];
  const duplicates: DuplicateUpload[] = [];
  for (const [index, uploadItem] of parsed.data.uploads.entries()) {
    // Only keys our token route could have authorized are registrable —
    // prevents pointing a document row at an arbitrary blob path.
    if (!UPLOAD_KEY_RE.test(uploadItem.storageKey)) {
      return NextResponse.json(
        { error: `Invalid storage key: ${uploadItem.storageKey}` },
        { status: 400 },
      );
    }
    // A key registers exactly once, ever. Client uploads mint a fresh uuid
    // key per file, so a collision is either a double-submit or an attempt
    // to attach another tenant's blob to a new row — refuse both. (Packet
    // children legitimately share a parent's key, but those rows are
    // created server-side by the processor, never through this route.)
    const existing = await db.query.documents.findFirst({
      where: eq(schema.documents.storageKey, uploadItem.storageKey),
      columns: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Already registered: ${uploadItem.storageKey}` },
        { status: 409 },
      );
    }
    let blob;
    try {
      blob = await head(uploadItem.storageKey);
    } catch {
      return NextResponse.json(
        { error: `Uploaded file not found: ${uploadItem.storageKey}` },
        { status: 400 },
      );
    }
    const contentHash = sha256Hex(await store.get(uploadItem.storageKey));
    const duplicateOf = await findDuplicateDocument(db, orgId, contentHash);
    if (duplicateOf) {
      await del(uploadItem.storageKey).catch(() => {});
      duplicates.push({ index, fileName: uploadItem.fileName, duplicateOf });
      continue;
    }
    const [doc] = await db
      .insert(schema.documents)
      .values({
        orgId,
        fileName: uploadItem.fileName,
        fileSize: blob.size,
        mimeType:
          uploadItem.mimeType || blob.contentType || "application/octet-stream",
        storageKey: uploadItem.storageKey,
        docType: inferDocType(uploadItem.fileName),
        status: "pending",
        sourceId,
        contentHash,
      })
      .returning();
    created.push(doc);
  }

  // Strip rawExtraction so the response shape matches DocumentListItem,
  // same as the server upload route.
  return NextResponse.json(
    {
      documents: created.map((doc) => {
        const { rawExtraction, ...rest } = doc;
        void rawExtraction;
        return rest;
      }),
      duplicates,
    },
    { status: created.length === 0 && duplicates.length > 0 ? 409 : 201 },
  );
}
