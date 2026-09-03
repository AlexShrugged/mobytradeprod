import { after } from "next/server";
import { and, eq, lt, ne, or } from "drizzle-orm";

import {
  findEntriesForDocument,
  queueAnalysesForEntries,
} from "@/lib/analysis/service";
import { db, schema } from "@/lib/db";
import type { Document } from "@/lib/db/schema";
import {
  classifyQuoteCreatedParts,
  findPartsCreatedByDocument,
} from "@/lib/quotes/auto-classify";

import { getProcessor } from "./index";
import { linkExtraction } from "./linker";
import { childFileName, orderPacketParts } from "./packet";
import { ProcessingError } from "./types";

const ANALYSIS_TRIGGER_DOC_TYPES = new Set<Document["docType"]>([
  "port_entry",
  "commercial_invoice",
]);

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
    const processor = await getProcessor(db);
    const { extraction, raw } = await processor.process({
      storageKey: doc.storageKey,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      docTypeHint: doc.docType,
      attempt,
      pageRange: doc.pageRange,
      packetRole: doc.packetRole,
    });

    // A packet splits into child documents BEFORE the parent persists, so a
    // failure here (nested packet, children mid-flight) lands on the normal
    // failure path. Children are delete+recreated on reprocess; their
    // document_links cascade away, and the domain records they created
    // persist and re-upsert by business number.
    let children: Document[] = [];
    if (extraction.docType === "entry_packet") {
      if (doc.parentDocumentId) {
        throw new ProcessingError(
          "A packet part cannot itself be an entry packet — split refused.",
        );
      }
      const inFlight = await db.query.documents.findMany({
        where: and(
          eq(schema.documents.parentDocumentId, doc.id),
          eq(schema.documents.status, "processing"),
        ),
        columns: { id: true },
      });
      if (inFlight.length > 0) {
        throw new ProcessingError(
          "Packet parts are still processing — retry when they finish.",
        );
      }
      await db
        .delete(schema.documents)
        .where(eq(schema.documents.parentDocumentId, doc.id));
      children = await db
        .insert(schema.documents)
        .values(
          orderPacketParts(extraction.fields.parts).map((part) => ({
            orgId: doc.orgId,
            fileName: childFileName(doc.fileName, part),
            // Children share the parent's bytes: same storageKey, and the
            // parent's byte count (cosmetic — there is no per-part file).
            fileSize: doc.fileSize,
            mimeType: doc.mimeType,
            storageKey: doc.storageKey,
            docType: part.doc_type,
            status: "pending" as const,
            sourceId: doc.sourceId,
            parentDocumentId: doc.id,
            packetRole: part.role,
            pageRange: part.pages,
          })),
        )
        .returning();
    }

    await linkExtraction(doc.orgId, doc.id, extraction, {
      parentDocumentId: doc.parentDocumentId,
    });

    // Only the two primary documents change what the analyst reasons
    // about: the 7501 (the entry's declared facts) and the commercial
    // invoice (the one document class compared against it). Those queue an
    // AI analysis for every entry whose bundle includes them; supporting
    // docs (cargo release, packing list, refund report) link but never
    // queue, so an entry gets one analysis unless its primary facts change.
    // The sweep drains after a settle window, so a packet's 7501 and CI
    // both land before the analyst starts (each touches the same pending
    // row).
    if (ANALYSIS_TRIGGER_DOC_TYPES.has(extraction.docType)) {
      await queueAnalysesForEntries(
        db,
        await findEntriesForDocument(db, doc.orgId, doc.id),
        "entry_change",
      );
    }

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

    // A quote sheet that minted draft SKUs gets them classified right away
    // — potential HTS codes, never a committed one — so their quotes price
    // to a landed cost before anyone opens the part. The model call runs
    // after the response; the document is already processed either way.
    if (extraction.docType === "quote_sheet") {
      const createdPartIds = await findPartsCreatedByDocument(
        db,
        doc.orgId,
        doc.id,
      );
      if (createdPartIds.length > 0) {
        await afterResponseOrNow(() =>
          classifyQuoteCreatedParts(db, doc.orgId, createdPartIds),
        );
      }
    }

    // Children run AFTER the parent persists as processed, sequentially:
    // 7501s first, then CIs (orderPacketParts), so a CI usually finds its
    // sibling entry on the first pass, and two children never race the
    // linker inside one packet run. Each child claims its own row — a child
    // failure marks only that child, never the parent.
    for (const child of children) {
      await processDocumentRow(child);
    }
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

// Defer a follow-up past the response when a request is in flight (route
// handlers, the cron sweep); run it inline where there is no request scope
// (scripts). after() throws synchronously outside a request, which is the
// branch signal.
async function afterResponseOrNow(task: () => Promise<unknown>): Promise<void> {
  const run = () =>
    task().catch((err) => {
      console.error("post-processing follow-up failed:", err);
    });
  try {
    after(run);
  } catch {
    await run();
  }
}
