import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { inferDocType } from "@/lib/processing";
import { getFileStore } from "@/lib/storage";

const sourceIdSchema = z.uuid();

export async function POST(request: Request) {
  const formData = await request.formData();
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided." }, { status: 400 });
  }

  const orgId = await getCurrentOrgId();

  // Which intake channel delivered these files. Callers wiring an automated
  // channel pass its sourceId; the browser dropzone passes nothing and gets
  // the org's manual-upload source row (null if the seed hasn't created one
  // — the column tolerates unknown provenance).
  const rawSourceId = formData.get("sourceId");
  let sourceId: string | null = null;
  if (typeof rawSourceId === "string" && rawSourceId !== "") {
    const parsed = sourceIdSchema.safeParse(rawSourceId);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid sourceId." }, { status: 400 });
    }
    const source = await db.query.integrationSources.findFirst({
      where: and(
        eq(schema.integrationSources.id, parsed.data),
        eq(schema.integrationSources.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!source) {
      return NextResponse.json(
        { error: "Unknown integration source." },
        { status: 400 },
      );
    }
    sourceId = source.id;
  } else {
    const manual = await db.query.integrationSources.findFirst({
      where: and(
        eq(schema.integrationSources.orgId, orgId),
        eq(schema.integrationSources.kind, "manual_upload"),
      ),
      columns: { id: true },
    });
    sourceId = manual?.id ?? null;
  }

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
