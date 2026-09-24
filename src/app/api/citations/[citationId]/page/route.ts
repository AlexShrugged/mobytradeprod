import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { highlightPage } from "@/lib/documents/highlight-pdf";
import { getCurrentOrgId } from "@/lib/org";
import { getFileStore } from "@/lib/storage";

// The page a cited fact was read from, highlighted: one page sliced out of
// the document's stored PDF with the citation's boxes drawn on it, opened
// inline by the browser's own viewer. Org-scoped like the file route (the
// citation is looked up under the session's org); nothing is stored — the
// slice is rebuilt from the bytes on every open.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ citationId: string }> },
) {
  const { citationId } = await params;
  const orgId = await getCurrentOrgId();

  const [row] = await db
    .select({
      page: schema.factCitations.page,
      boxes: schema.factCitations.boxes,
      documentId: schema.documents.id,
      fileName: schema.documents.fileName,
      mimeType: schema.documents.mimeType,
      storageKey: schema.documents.storageKey,
    })
    .from(schema.factCitations)
    .innerJoin(
      schema.documents,
      eq(schema.factCitations.documentId, schema.documents.id),
    )
    .where(
      and(
        eq(schema.factCitations.id, citationId),
        eq(schema.factCitations.orgId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return Response.json({ error: "Citation not found" }, { status: 404 });
  }

  // Only a PDF can be sliced. An image upload is one page already: show
  // the whole document.
  if (row.mimeType !== "application/pdf") {
    return Response.redirect(
      new URL(`/api/documents/${row.documentId}/file?disposition=inline`, req.url),
      302,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await getFileStore().get(row.storageKey);
  } catch {
    return Response.json(
      { error: "Stored file is missing from the file store" },
      { status: 410 },
    );
  }

  let sliced: Uint8Array;
  try {
    sliced = await highlightPage(new Uint8Array(bytes), row.page, row.boxes);
  } catch (err) {
    console.error(`citation ${citationId}: could not render page`, err);
    return Response.json(
      { error: "Could not render the cited page" },
      { status: 422 },
    );
  }

  // Header values must be Latin-1; file names are not (packet children carry
  // an en dash in "pp. 3–6"). RFC 6266 dual form, as the file route does.
  const baseName = row.fileName.replace(/\.pdf$/i, "");
  const name = `${baseName} p${row.page}.pdf`;
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const utf8Name = encodeURIComponent(name);

  // A fresh copy: pdf-lib's buffer is typed as possibly shared, which the
  // Response body type refuses.
  return new Response(new Uint8Array(sliced), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
