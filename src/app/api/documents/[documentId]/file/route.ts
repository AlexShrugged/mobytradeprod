import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { getFileStore } from "@/lib/storage";
import { BlobFileStore } from "@/lib/storage/blob";

// mimeType is browser-supplied at upload — inline HTML/SVG from the same
// origin would be a stored-XSS vector, so those always download.
const INLINE_BLOCKED = new Set([
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
]);

// Streams a stored document back to the browser. Default disposition is
// attachment (download); ?disposition=inline opens it in the browser for
// types that are safe to render.
export async function GET(
  req: Request,
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

  const mimeType = doc.mimeType || "application/octet-stream";
  const inline =
    new URL(req.url).searchParams.get("disposition") === "inline" &&
    !INLINE_BLOCKED.has(mimeType);

  const store = getFileStore();

  // Blob store: redirect to the CDN instead of proxying bytes through the
  // function — avoids the serverless response-size cap entirely. Org-scoped
  // auth above gates who learns the (unguessable) URL. ?download=1 makes
  // Blob serve Content-Disposition: attachment.
  if (store instanceof BlobFileStore) {
    let url: string;
    try {
      url = await store.resolveUrl(doc.storageKey);
    } catch {
      return Response.json(
        { error: "Stored file is missing from the file store" },
        { status: 410 },
      );
    }
    return Response.redirect(inline ? url : `${url}?download=1`, 302);
  }

  let bytes: Buffer;
  try {
    bytes = await store.get(doc.storageKey);
  } catch {
    return Response.json(
      { error: "Stored file is missing from the file store" },
      { status: 410 },
    );
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${doc.fileName.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
