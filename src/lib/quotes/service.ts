// DB effects for the quote workflow — the ONLY writer of quote_sheets,
// quote_lines, and quote-sourced part writes (draft-part creation on
// unknown SKUs, application onto unit_cost / country_of_origin /
// manufacturer) plus their field_changes rows, so the badges the UI derives
// from quote state ("quote received", "pending changes") can never drift
// from what was actually decided. HTS is NEVER written here — a
// supplier-claimed code is display/estimate input only and routes through
// classification/service.ts.
//
// The decision rules themselves (matching, winner selection, supersede
// selection, part-field diffing) are pure functions in ./match.ts,
// test-pinned without a database; this module only executes them.
//
// Every entry point expects to run inside a transaction (routes pass a tx;
// the ingestion linker delegates in-transaction; the seed passes its
// standalone db).
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "../db";
import * as schema from "../db/schema";
import {
  diffQuoteAgainstPart,
  pickWinningQuote,
  poLineMatchesQuote,
  selectSupersededLineIds,
  type PartFieldDiff,
} from "./match";

/** The route maps this to a 409 — the line moved under the caller. */
export class QuoteStateError extends Error {}

export type QuoteLineInput = {
  lineNumber: number;
  sku: string;
  description?: string | null;
  unitCost: number;
  currency?: string | null;
  countryOfOrigin?: string | null;
  htsCode?: string | null;
  moq?: number | null;
  leadTimeDays?: number | null;
  unitOfMeasure?: string | null;
};

export type IngestQuoteSheetInput = {
  documentId?: string | null;
  supplierName?: string | null;
  quoteDate?: string | null; // ISO date
  currency?: string | null;
  validUntil?: string | null; // ISO date
  notes?: string | null;
  lines: QuoteLineInput[];
};

export type IngestQuoteSheetResult = {
  sheet: schema.QuoteSheet;
  lines: schema.QuoteLine[];
  createdPartIds: string[];
};

/**
 * Create a sheet + its lines. Every line resolves to a part by (org, sku);
 * an unknown SKU auto-creates a DRAFT part seeded with the quote's own
 * claims (draft = "not official": the auditor ignores it and nothing
 * drives money until a human approves). Newly received lines auto-supersede
 * older RECEIVED lines for the same (part, supplier); approved lines are
 * never auto-superseded — human decisions survive machine re-ingestion.
 */
export async function ingestQuoteSheet(
  db: DbClient,
  orgId: string,
  input: IngestQuoteSheetInput,
): Promise<IngestQuoteSheetResult> {
  const sheetCurrency = input.currency?.trim().toUpperCase() || "USD";
  const supplierName = input.supplierName?.trim() || null;

  const [sheet] = await db
    .insert(schema.quoteSheets)
    .values({
      orgId,
      documentId: input.documentId ?? null,
      supplierName,
      quoteDate: input.quoteDate ?? null,
      currency: sheetCurrency,
      validUntil: input.validUntil ?? null,
      notes: input.notes?.trim() || null,
    })
    .returning();

  const lines: schema.QuoteLine[] = [];
  const createdPartIds: string[] = [];

  for (const line of input.lines) {
    const sku = line.sku.trim();
    const description = line.description?.trim() || null;
    const countryOfOrigin = line.countryOfOrigin?.trim().toUpperCase() || null;

    let part = await db.query.parts.findFirst({
      where: and(eq(schema.parts.orgId, orgId), eq(schema.parts.sku, sku)),
    });
    let partCreated = false;

    if (!part) {
      const [created] = await db
        .insert(schema.parts)
        .values({
          orgId,
          sku,
          name: description ?? sku,
          description,
          manufacturer: supplierName,
          unitCost: line.unitCost.toFixed(4),
          countryOfOrigin,
          status: "draft",
        })
        .returning();
      part = created;
      partCreated = true;
      createdPartIds.push(created.id);

      // One provenance row marking the creation; the seeded field values
      // are visible on the part itself and become official only on apply.
      await db.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: created.id,
        field: "created",
        oldValue: null,
        newValue: sku,
        source: "quote:draft_create",
        actor: null,
        note: `Draft part created from quote${
          supplierName ? ` from ${supplierName}` : ""
        }${sheet.quoteDate ? ` dated ${sheet.quoteDate}` : ""}`,
      });
    }

    const [inserted] = await db
      .insert(schema.quoteLines)
      .values({
        orgId,
        quoteSheetId: sheet.id,
        lineNumber: line.lineNumber,
        partId: part.id,
        partCreated,
        sku,
        description,
        unitCost: line.unitCost.toFixed(4),
        currency: line.currency?.trim().toUpperCase() || sheetCurrency,
        countryOfOrigin,
        htsCode: line.htsCode?.trim() || null,
        moq: line.moq == null ? null : String(line.moq),
        leadTimeDays: line.leadTimeDays ?? null,
        unitOfMeasure: line.unitOfMeasure?.trim() || null,
      })
      .returning();
    lines.push(inserted);

    const openLines = await db
      .select({
        id: schema.quoteLines.id,
        partId: schema.quoteLines.partId,
        status: schema.quoteLines.status,
        supplierName: schema.quoteSheets.supplierName,
      })
      .from(schema.quoteLines)
      .innerJoin(
        schema.quoteSheets,
        eq(schema.quoteLines.quoteSheetId, schema.quoteSheets.id),
      )
      .where(
        and(
          eq(schema.quoteLines.orgId, orgId),
          eq(schema.quoteLines.partId, part.id),
          eq(schema.quoteLines.status, "received"),
        ),
      );
    const supersededIds = selectSupersededLineIds(
      { id: inserted.id, partId: part.id, supplierName },
      openLines,
    );
    if (supersededIds.length > 0) {
      await db
        .update(schema.quoteLines)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(inArray(schema.quoteLines.id, supersededIds));
    }
  }

  return { sheet, lines, createdPartIds };
}

export type QuoteDecisionResult = {
  line: schema.QuoteLine;
  part: schema.Part;
};

/**
 * Approve or reject a RECEIVED quote line.
 *
 * Approve on an active part: the line waits as "approved" until a matching
 * PO confirms it (applyQuotesForPo) — the part is untouched; "pending
 * changes" is derived. Approve on a DRAFT part finalizes a brand-new SKU:
 * there is no prior official state a PO needs to confirm, so the part flips
 * active, the quote's values land where they differ, and the line goes
 * straight to applied (applied_po_line_id stays null — no PO made it so).
 *
 * Reject leaves a draft part draft — surfaced on the Parts page for
 * archiving, deliberately not auto-archived (a better quote may be coming).
 *
 * Deciding any non-received line (including superseded ones) throws
 * QuoteStateError: the UI always shows the fresh line.
 */
export async function decideQuoteLine(
  db: DbClient,
  orgId: string,
  quoteLineId: string,
  action: "approve" | "reject",
  decidedBy: string,
  note?: string,
): Promise<QuoteDecisionResult | null> {
  const line = await db.query.quoteLines.findFirst({
    where: and(
      eq(schema.quoteLines.id, quoteLineId),
      eq(schema.quoteLines.orgId, orgId),
    ),
  });
  if (!line) return null;

  if (line.status !== "received") {
    throw new QuoteStateError(
      `This quote line is ${line.status}; only received lines can be decided. Refresh and retry.`,
    );
  }

  const part = await db.query.parts.findFirst({
    where: eq(schema.parts.id, line.partId),
  });
  if (!part) {
    throw new QuoteStateError(
      "The part behind this quote line no longer exists.",
    );
  }

  const now = new Date();
  const decisionFields = {
    decidedBy,
    decidedAt: now,
    decisionNote: note?.trim() || null,
    updatedAt: now,
  };

  if (action === "reject") {
    const [updated] = await db
      .update(schema.quoteLines)
      .set({ status: "rejected", ...decisionFields })
      .where(eq(schema.quoteLines.id, line.id))
      .returning();
    return { line: updated, part };
  }

  if (part.status !== "draft") {
    const [updated] = await db
      .update(schema.quoteLines)
      .set({ status: "approved", ...decisionFields })
      .where(eq(schema.quoteLines.id, line.id))
      .returning();
    return { line: updated, part };
  }

  // Draft-finalize path.
  const sheet = await db.query.quoteSheets.findFirst({
    where: eq(schema.quoteSheets.id, line.quoteSheetId),
  });
  const diffs = diffQuoteAgainstPart(
    {
      unitCost: Number(line.unitCost),
      countryOfOrigin: line.countryOfOrigin,
      supplierName: sheet?.supplierName ?? null,
    },
    part,
  );

  const partPatch: Partial<typeof schema.parts.$inferInsert> = {
    status: "active",
    updatedAt: now,
  };
  for (const d of diffs) partPatch[d.column] = d.newValue;
  const [updatedPart] = await db
    .update(schema.parts)
    .set(partPatch)
    .where(eq(schema.parts.id, part.id))
    .returning();

  await recordAppliedDiffs(db, orgId, part.id, diffs, {
    actor: decidedBy,
    note: `Quote${
      sheet?.supplierName ? ` from ${sheet.supplierName}` : ""
    } approved — draft SKU finalized`,
  });

  const [updatedLine] = await db
    .update(schema.quoteLines)
    .set({
      status: "applied",
      appliedAt: now,
      appliedPoLineId: null,
      ...decisionFields,
    })
    .where(eq(schema.quoteLines.id, line.id))
    .returning();

  return { line: updatedLine, part: updatedPart };
}

/** Sheet-level convenience: approve every remaining RECEIVED line. */
export async function approveAllForSheet(
  db: DbClient,
  orgId: string,
  sheetId: string,
  decidedBy: string,
): Promise<QuoteDecisionResult[] | null> {
  const sheet = await db.query.quoteSheets.findFirst({
    where: and(
      eq(schema.quoteSheets.id, sheetId),
      eq(schema.quoteSheets.orgId, orgId),
    ),
  });
  if (!sheet) return null;

  const received = await db.query.quoteLines.findMany({
    where: and(
      eq(schema.quoteLines.quoteSheetId, sheetId),
      eq(schema.quoteLines.status, "received"),
    ),
    orderBy: (t, { asc }) => [asc(t.lineNumber)],
  });

  const results: QuoteDecisionResult[] = [];
  for (const line of received) {
    const result = await decideQuoteLine(db, orgId, line.id, "approve", decidedBy);
    if (result) results.push(result);
  }
  return results;
}

export type QuoteApplication = {
  poLineId: string;
  quoteLineId: string;
  partId: string;
  /** field_changes.field values actually written (may be empty — a PO can
   *  confirm a quote without moving any part field). */
  changedFields: string[];
};

/**
 * The linker hook (also callable standalone): for each line of a PO, find
 * the approved quote lines its part could confirm, filter through
 * poLineMatchesQuote, pick the most recent winner, and make it official —
 * parts.unit_cost (+COO/manufacturer when the quote carries them and they
 * differ), one field_changes row PER changed field, and the quote line
 * moves to applied with the confirming PO line recorded. Re-running is
 * idempotent: applied lines are no longer "approved" and never re-match.
 * "Last matching PO applied wins the official cost" falls out of that —
 * each later application simply overwrites. Never writes hts_code.
 */
export async function applyQuotesForPo(
  db: DbClient,
  orgId: string,
  purchaseOrderId: string,
): Promise<QuoteApplication[] | null> {
  const po = await db.query.purchaseOrders.findFirst({
    where: and(
      eq(schema.purchaseOrders.id, purchaseOrderId),
      eq(schema.purchaseOrders.orgId, orgId),
    ),
  });
  if (!po) return null;

  const poLines = await db.query.purchaseOrderLines.findMany({
    where: eq(schema.purchaseOrderLines.purchaseOrderId, purchaseOrderId),
    orderBy: (t, { asc }) => [asc(t.lineNumber)],
  });

  const applications: QuoteApplication[] = [];

  for (const poLine of poLines) {
    if (!poLine.partId) continue;

    // Re-queried per line: applying below flips a line off "approved"
    // in-transaction, so one quote line never applies to two PO lines.
    const candidates = await db
      .select({ line: schema.quoteLines, sheet: schema.quoteSheets })
      .from(schema.quoteLines)
      .innerJoin(
        schema.quoteSheets,
        eq(schema.quoteLines.quoteSheetId, schema.quoteSheets.id),
      )
      .where(
        and(
          eq(schema.quoteLines.orgId, orgId),
          eq(schema.quoteLines.partId, poLine.partId),
          eq(schema.quoteLines.status, "approved"),
        ),
      );

    const matching = candidates.filter(({ line, sheet }) =>
      poLineMatchesQuote(
        {
          partId: poLine.partId,
          unitPrice: poLine.unitPrice === null ? null : Number(poLine.unitPrice),
          orderDate: po.orderDate,
          currency: po.currency,
          supplierName: po.supplierName,
        },
        {
          partId: line.partId,
          unitCost: Number(line.unitCost),
          currency: line.currency,
          quoteDate: sheet.quoteDate,
          supplierName: sheet.supplierName,
        },
      ),
    );

    const winner = pickWinningQuote(
      matching.map(({ line, sheet }) => ({
        id: line.id,
        createdAt: line.createdAt,
        quoteDate: sheet.quoteDate,
        line,
        sheet,
      })),
    );
    if (!winner) continue;

    const part = await db.query.parts.findFirst({
      where: eq(schema.parts.id, poLine.partId),
    });
    // Archived parts are read-only history — never write costs onto them.
    if (!part || part.status === "archived") continue;

    const now = new Date();
    const diffs = diffQuoteAgainstPart(
      {
        unitCost: Number(winner.line.unitCost),
        countryOfOrigin: winner.line.countryOfOrigin,
        supplierName: winner.sheet.supplierName,
      },
      part,
    );

    if (diffs.length > 0) {
      const partPatch: Partial<typeof schema.parts.$inferInsert> = {
        updatedAt: now,
      };
      for (const d of diffs) partPatch[d.column] = d.newValue;
      await db
        .update(schema.parts)
        .set(partPatch)
        .where(eq(schema.parts.id, part.id));

      await recordAppliedDiffs(db, orgId, part.id, diffs, {
        actor: null,
        note: `Quote${
          winner.sheet.supplierName ? ` from ${winner.sheet.supplierName}` : ""
        } applied via PO ${po.poNumber}`,
      });
    }

    await db
      .update(schema.quoteLines)
      .set({
        status: "applied",
        appliedAt: now,
        appliedPoLineId: poLine.id,
        updatedAt: now,
      })
      .where(eq(schema.quoteLines.id, winner.line.id));

    applications.push({
      poLineId: poLine.id,
      quoteLineId: winner.line.id,
      partId: part.id,
      changedFields: diffs.map((d) => d.field),
    });
  }

  return applications;
}

/** One field_changes row per changed part field, source "quote:applied". */
async function recordAppliedDiffs(
  db: DbClient,
  orgId: string,
  partId: string,
  diffs: PartFieldDiff[],
  opts: { actor: string | null; note: string },
): Promise<void> {
  for (const d of diffs) {
    await db.insert(schema.fieldChanges).values({
      orgId,
      entityType: "part",
      entityId: partId,
      field: d.field,
      oldValue: d.oldValue,
      newValue: d.newValue,
      source: "quote:applied",
      actor: opts.actor,
      note: opts.note,
      reviewItemId: null,
    });
  }
}
