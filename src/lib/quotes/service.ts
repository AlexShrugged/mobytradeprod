// DB effects for the quote workflow — the ONLY writer of quote_sheets,
// quote_lines, and quote-sourced catalog writes (draft-part creation on
// unknown SKUs, application onto the (part, vendor) part_sources row's
// unit_cost / country_of_origin) plus their field_changes rows, so the
// badges the UI derives from quote state ("quote received", "pending
// changes") can never drift from what was actually decided. HTS is NEVER
// written here — a supplier-claimed code is display/estimate input only and
// routes through classification/service.ts.
//
// The decision rules themselves (matching, winner selection, supersede
// selection, source-field diffing) are pure functions in ./match.ts,
// test-pinned without a database; this module only executes them. Vendor
// identity is resolved once per sheet via vendors/service.ts; a sheet that
// names no supplier gets a null vendor, and its quotes can flip to applied
// WITHOUT a catalog write — there is no (part, vendor) row to land on.
//
// Every entry point expects to run inside a transaction (routes pass a tx;
// the ingestion linker delegates in-transaction; the seed passes its
// standalone db).
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray, isNull } from "drizzle-orm";

import type { DbClient } from "../db";
import * as schema from "../db/schema";
import { planCommitWindow } from "../effective-dating";
import { findOrCreateVendor } from "../vendors/service";
import {
  diffQuoteAgainstSource,
  pickWinningQuote,
  poLineMatchesQuote,
  selectSupersededLineIds,
  type SourceFieldDiff,
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
 * claims — cost and COO land on the (part, vendor) part_sources row when
 * the sheet names a supplier (draft = "not official": the auditor ignores
 * it and nothing drives money until a human approves). Newly received lines
 * auto-supersede older RECEIVED lines for the same (part, vendor); approved
 * lines are never auto-superseded — human decisions survive machine
 * re-ingestion.
 */
export async function ingestQuoteSheet(
  db: DbClient,
  orgId: string,
  input: IngestQuoteSheetInput,
): Promise<IngestQuoteSheetResult> {
  const sheetCurrency = input.currency?.trim().toUpperCase() || "USD";
  const supplierName = input.supplierName?.trim() || null;
  const vendor = await findOrCreateVendor(db, orgId, supplierName);

  const [sheet] = await db
    .insert(schema.quoteSheets)
    .values({
      orgId,
      documentId: input.documentId ?? null,
      supplierName,
      vendorId: vendor?.id ?? null,
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
          status: "draft",
        })
        .returning();
      part = created;
      partCreated = true;
      createdPartIds.push(created.id);

      // The quote's cost/COO claims live on the (part, vendor) source row.
      // A sheet with no supplier has no vendor to hang them on — the draft
      // part stays sourceless until a named quote or manual edit arrives.
      if (vendor) {
        await db.insert(schema.partSources).values({
          orgId,
          partId: created.id,
          vendorId: vendor.id,
          countryOfOrigin,
          unitCost: line.unitCost.toFixed(4),
        });
      }

      // One provenance row marking the creation; the seeded field values
      // are visible on the part itself and become official only on apply.
      await db.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: created.id,
        vendorId: vendor?.id ?? null,
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
        vendorId: schema.quoteSheets.vendorId,
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
      { id: inserted.id, partId: part.id, vendorId: vendor?.id ?? null },
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
 * PO confirms it (applyQuotesForPo) — the catalog is untouched; "pending
 * changes" is derived. Approve on a DRAFT part finalizes a brand-new SKU:
 * there is no prior official state a PO needs to confirm, so the part flips
 * active, the quote's values land on the sheet vendor's (part, vendor)
 * source row where they differ, and the line goes straight to applied
 * (applied_po_line_id stays null — no PO made it so).
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

  // Draft-finalize path. The quote's values land on the (part, vendor)
  // source row; the part itself only flips active. A sheet with no vendor
  // finalizes the part with no catalog write — there is no source to land
  // on (documented module contract).
  const sheet = await db.query.quoteSheets.findFirst({
    where: eq(schema.quoteSheets.id, line.quoteSheetId),
  });
  const sourceVendorId = sheet?.vendorId ?? null;

  if (sourceVendorId) {
    const source = await db.query.partSources.findFirst({
      where: and(
        eq(schema.partSources.partId, part.id),
        eq(schema.partSources.vendorId, sourceVendorId),
        isNull(schema.partSources.validTo),
      ),
    });
    const diffs = diffQuoteAgainstSource(
      {
        unitCost: Number(line.unitCost),
        countryOfOrigin: line.countryOfOrigin,
      },
      source ?? null,
    );
    await patchPartSource(db, orgId, part.id, sourceVendorId, source, diffs, now);
    await recordAppliedDiffs(db, orgId, part.id, sourceVendorId, diffs, {
      actor: decidedBy,
      note: `Quote${
        sheet?.supplierName ? ` from ${sheet.supplierName}` : ""
      } approved; draft SKU finalized`,
    });
  }

  const [updatedPart] = await db
    .update(schema.parts)
    .set({ status: "active", updatedAt: now })
    .where(eq(schema.parts.id, part.id))
    .returning();

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
 * the (part, vendor) source row's unit_cost (+COO when the quote carries
 * one and it differs), one field_changes row PER changed field, and the
 * quote line moves to applied with the confirming PO line recorded. The
 * source vendor is the sheet's, falling back to the PO's; with neither, the
 * line still applies but nothing lands in the catalog. Re-running is
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
          vendorId: po.vendorId,
        },
        {
          partId: line.partId,
          unitCost: Number(line.unitCost),
          currency: line.currency,
          quoteDate: sheet.quoteDate,
          vendorId: sheet.vendorId,
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
    const sourceVendorId = winner.sheet.vendorId ?? po.vendorId;
    let changedFields: string[] = [];

    if (sourceVendorId) {
      const source = await db.query.partSources.findFirst({
        where: and(
          eq(schema.partSources.partId, part.id),
          eq(schema.partSources.vendorId, sourceVendorId),
          isNull(schema.partSources.validTo),
        ),
      });
      const diffs = diffQuoteAgainstSource(
        {
          unitCost: Number(winner.line.unitCost),
          countryOfOrigin: winner.line.countryOfOrigin,
        },
        source ?? null,
      );
      if (diffs.length > 0) {
        await patchPartSource(
          db,
          orgId,
          part.id,
          sourceVendorId,
          source,
          diffs,
          now,
        );
        await recordAppliedDiffs(db, orgId, part.id, sourceVendorId, diffs, {
          actor: null,
          note: `Quote${
            winner.sheet.supplierName ? ` from ${winner.sheet.supplierName}` : ""
          } applied via PO ${po.poNumber}`,
        });
        changedFields = diffs.map((d) => d.field);
      }
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
      changedFields,
    });
  }

  return applications;
}

/** Apply source-field diffs onto the (part, vendor) sourcing facts. A quote
 *  application is a dated fact — "the cost/origin changed from this day
 *  forward" — so it TILES: the current window closes at day − 1 and a
 *  successor opens carrying all current values with the diffs applied.
 *  Historical entries keep auditing against the window of their day. A
 *  same-day re-application corrects the fresh window in place instead of
 *  minting a zero-length one. `existing` must be the CURRENT (valid_to
 *  null) window. No-ops on an empty diff. */
async function patchPartSource(
  db: DbClient,
  orgId: string,
  partId: string,
  vendorId: string,
  existing: schema.PartSource | undefined,
  diffs: SourceFieldDiff[],
  now: Date,
): Promise<void> {
  if (diffs.length === 0) return;
  const effectiveDate = now.toISOString().slice(0, 10);
  if (existing) {
    const plan = planCommitWindow(
      { validFrom: existing.validFrom },
      effectiveDate,
    );
    if (plan.action === "tile") {
      await db
        .update(schema.partSources)
        .set({ validTo: plan.closePredecessorAt, updatedAt: now })
        .where(eq(schema.partSources.id, existing.id));
      const values: typeof schema.partSources.$inferInsert = {
        orgId,
        partId,
        vendorId,
        countryOfOrigin: existing.countryOfOrigin,
        unitCost: existing.unitCost,
        validFrom: effectiveDate,
        validTo: null,
      };
      for (const d of diffs) values[d.column] = d.newValue;
      await db.insert(schema.partSources).values(values);
    } else {
      const patch: Partial<typeof schema.partSources.$inferInsert> = {
        updatedAt: now,
      };
      for (const d of diffs) patch[d.column] = d.newValue;
      await db
        .update(schema.partSources)
        .set(patch)
        .where(eq(schema.partSources.id, existing.id));
    }
  } else {
    // New vendor for this part — but if closed windows exist (the source was
    // "deleted"), the new window starts today rather than rewriting the gap.
    const priorWindow = await db.query.partSources.findFirst({
      where: and(
        eq(schema.partSources.partId, partId),
        eq(schema.partSources.vendorId, vendorId),
      ),
    });
    const values: typeof schema.partSources.$inferInsert = {
      orgId,
      partId,
      vendorId,
      validFrom: priorWindow ? effectiveDate : null,
      validTo: null,
    };
    for (const d of diffs) values[d.column] = d.newValue;
    await db.insert(schema.partSources).values(values);
  }
}

/** One field_changes row per changed source field, source "quote:applied";
 *  vendor_id scopes the change to its (part, vendor) row. */
async function recordAppliedDiffs(
  db: DbClient,
  orgId: string,
  partId: string,
  vendorId: string,
  diffs: SourceFieldDiff[],
  opts: { actor: string | null; note: string },
): Promise<void> {
  for (const d of diffs) {
    await db.insert(schema.fieldChanges).values({
      orgId,
      entityType: "part",
      entityId: partId,
      vendorId,
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
