import { NextResponse } from "next/server";
import { head } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { resolveSourceId } from "@/lib/documents/source";
import { UPLOAD_KEY_RE } from "@/lib/documents/upload-key";
import { getCurrentOrgId } from "@/lib/org";
import { inferDocType } from "@/lib/processing";

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
// from the client.
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const orgId = await getCurrentOrgId();

  const resolved = await resolveSourceId(orgId, parsed.data.sourceId ?? null);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const { sourceId } = resolved;

  const created = [];
  for (const uploadItem of parsed.data.uploads) {
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
    },
    { status: 201 },
  );
}
