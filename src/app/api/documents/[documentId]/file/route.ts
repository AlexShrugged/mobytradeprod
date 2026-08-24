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

  // Header values must be Latin-1; file names are not (packet children carry
  // an en dash in "pp. 3–6"). RFC 6266 dual form: pure-ASCII fallback in
  // filename=, the real name UTF-8 percent-encoded in filename* — so the
  // header build can never throw on a stored name.
  const asciiName = doc.fileName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "");
  const utf8Name = encodeURIComponent(doc.fileName);

  const headers = {
    "Content-Type": mimeType,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };

  // Blob store: blobs are private (no unauthenticated URL to redirect to),
  // so stream the authenticated SDK read straight through — no buffering,
  // org-scoped auth above gates access.
  if (store instanceof BlobFileStore) {
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await store.getStream(doc.storageKey);
    } catch {
      return Response.json(
        { error: "Stored file is missing from the file store" },
        { status: 410 },
      );
    }
    return new Response(stream, { headers });
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

  return new Response(new Uint8Array(bytes), { headers });
}
