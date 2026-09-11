import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";

import { schema, type DbClient } from "@/lib/db";

import type { DuplicateOf } from "./duplicates";

/** SHA-256 of a file's bytes as lowercase hex — the documents.content_hash value. */
export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The earliest parent document in the org with these bytes, whatever its
// status: a failed twin is still the same document (reprocess it rather
// than re-upload it). Packet children never carry a hash, so a packet's
// pages can never shadow a standalone upload of the same bytes.
export async function findDuplicateDocument(
  db: DbClient,
  orgId: string,
  contentHash: string,
): Promise<DuplicateOf | null> {
  const row = await db.query.documents.findFirst({
    where: and(
      eq(schema.documents.orgId, orgId),
      eq(schema.documents.contentHash, contentHash),
      isNull(schema.documents.parentDocumentId),
    ),
    orderBy: [asc(schema.documents.uploadedAt), asc(schema.documents.id)],
    columns: { id: true, fileName: true, uploadedAt: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    fileName: row.fileName,
    uploadedAt: row.uploadedAt.toISOString(),
  };
}
