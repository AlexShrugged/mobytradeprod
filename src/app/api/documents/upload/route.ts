import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";
import { findDuplicateDocument, sha256Hex } from "@/lib/documents/content-hash";
import type { DuplicateUpload } from "@/lib/documents/duplicates";
import { resolveSourceId } from "@/lib/documents/source";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";
import { inferDocType } from "@/lib/processing";
import { getFileStore } from "@/lib/storage";

// Server-side pass-through upload: bytes travel through the function, so
// requests are subject to the platform body cap (~4.5MB on Vercel). The
// dropzone uses the client-direct blob flow (upload-token + register) in
// prod; this route remains the dev path and the entry point for future
// server-side connectors. Same duplicate contract as the register route:
// a file identical to a document already on file is reported in
// `duplicates` instead of stored, and the response is 409 only when
// nothing in the batch was new.
export async function POST(request: Request) {
  const formData = await request.formData();
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided." }, { status: 400 });
  }

  const orgId = await getCurrentOrgId();
  // The person behind a native upload — the Data page's Source for rows
  // that came through the dropzone rather than an automated channel.
  const uploadedBy = await getCurrentActorName();

  const rawSourceId = formData.get("sourceId");
  const resolved = await resolveSourceId(
    orgId,
    typeof rawSourceId === "string" ? rawSourceId : null,
  );
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const { sourceId } = resolved;

  const store = getFileStore();

  const created = [];
  const duplicates: DuplicateUpload[] = [];
  for (const [index, file] of files.entries()) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const contentHash = sha256Hex(buffer);
    const duplicateOf = await findDuplicateDocument(db, orgId, contentHash);
    if (duplicateOf) {
      duplicates.push({ index, fileName: file.name, duplicateOf });
      continue;
    }
    const { storageKey } = await store.put(file.name, buffer);
    const [doc] = await db
      .insert(schema.documents)
      .values({
        orgId,
        fileName: file.name,
        fileSize: buffer.byteLength,
        mimeType: file.type || "application/octet-stream",
        storageKey,
        docType: inferDocType(file.name),
        status: "pending",
        sourceId,
        uploadedBy,
        contentHash,
      })
      .returning();
    created.push(doc);
  }

  // documents.rawExtraction is null on fresh rows, but strip it anyway so
  // the response shape matches DocumentListItem everywhere.
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
