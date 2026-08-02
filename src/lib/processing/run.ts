import { and, eq, lt, ne, or } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { Document } from "@/lib/db/schema";

import { getProcessor } from "./index";
import { linkExtraction } from "./linker";
import { ProcessingError } from "./types";

export type ProcessRunOutcome =
  | { claimed: false }
  | { claimed: true; ok: boolean; document: Document };

// Claim → extract → link → persist outcome, shared by the interactive
// process route and the cron sweep. The claim is a guarded UPDATE on
// status, so two callers racing for the same document resolve to exactly
// one processor — the loser gets { claimed: false } and must not touch the
// row. `reclaimStaleBefore` lets the sweep steal "processing" rows whose
// runner died mid-flight (updatedAt older than the cutoff); interactive
// callers omit it and bounce off in-flight rows.
export async function processDocumentRow(
  doc: Document,
  opts: { reclaimStaleBefore?: Date } = {},
): Promise<ProcessRunOutcome> {
  const notInFlight = ne(schema.documents.status, "processing");
  const [claim] = await db
    .update(schema.documents)
    .set({ status: "processing", errorMessage: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.documents.id, doc.id),
        opts.reclaimStaleBefore
          ? or(
              notInFlight,
              lt(schema.documents.updatedAt, opts.reclaimStaleBefore),
            )
          : notInFlight,
      ),
    )
    .returning({ id: schema.documents.id });
  if (!claim) return { claimed: false };

  const attempt = doc.status === "failed" ? 2 : 1;

  try {
    const { extraction, raw } = await getProcessor().process({
      storageKey: doc.storageKey,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      docTypeHint: doc.docType,
      attempt,
    });

    await linkExtraction(doc.orgId, doc.id, extraction);

    const [updated] = await db
      .update(schema.documents)
      .set({
        status: "processed",
        docType: extraction.docType,
        extractedData: extraction.fields,
        rawExtraction: raw,
        parseJobId: raw?.parse.jobId ?? null,
        processedBy: raw ? raw.provider : "stub",
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.documents.id, doc.id))
      .returning();
    return { claimed: true, ok: true, document: updated };
  } catch (err) {
    // Keep the cause chain: a drizzle "Failed query" message without the
    // underlying constraint/column detail is undiagnosable from the UI.
    const message =
      err instanceof Error
        ? err.cause instanceof Error
          ? `${err.message}\ncause: ${err.cause.message}`
          : err.message
        : "Processing failed unexpectedly.";
    // A ProcessingError can carry the parse payload from before the failure;
    // persist it — it is paid for and reusable for debugging and retries.
    const failedRaw = err instanceof ProcessingError ? err.raw : null;
    const [updated] = await db
      .update(schema.documents)
      .set({
        status: "failed",
        errorMessage: message,
        ...(failedRaw
          ? {
              rawExtraction: failedRaw,
              parseJobId:
                err instanceof ProcessingError ? err.parseJobId : null,
            }
          : {}),
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.documents.id, doc.id))
      .returning();
    return { claimed: true, ok: false, document: updated };
  }
}
