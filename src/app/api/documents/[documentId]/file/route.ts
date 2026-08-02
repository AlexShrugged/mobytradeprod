import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { getFileStore } from "@/lib/storage";

// Streams a stored document back to the browser — the download affordance on
// event provenance panels and the documents table.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const orgId = await getCurrentOrgId();

  const doc = await db.query.documents.findFirst({
    where: and(
      eq(schema.documents.id, documentId),
      eq(schema.documents.orgId, orgId),
    ),
    columns: { fileName: true, mimeType: true, storageKey: true },
  });
  if (!doc) {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await getFileStore().get(doc.storageKey);
  } catch {
    return Response.json(
      { error: "Stored file is missing from the file store" },
      { status: 410 },
    );
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": doc.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${doc.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}
