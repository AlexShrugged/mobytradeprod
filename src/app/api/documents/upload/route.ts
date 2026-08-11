import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";
import { resolveSourceId } from "@/lib/documents/source";
import { getCurrentOrgId } from "@/lib/org";
import { inferDocType } from "@/lib/processing";
import { getFileStore } from "@/lib/storage";

// Server-side pass-through upload: bytes travel through the function, so
// requests are subject to the platform body cap (~4.5MB on Vercel). The
// dropzone uses the client-direct blob flow (upload-token + register) in
// prod; this route remains the dev path and the entry point for future
// server-side connectors.
export async function POST(request: Request) {
  const formData = await request.formData();
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided." }, { status: 400 });
  }

  const orgId = await getCurrentOrgId();

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
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
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
    },
    { status: 201 },
  );
}
