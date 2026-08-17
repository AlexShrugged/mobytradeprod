// DB effects for the classification/review workflow — the ONLY writer of
// hts_classifications, field_changes, the parts review projection columns,
// and review_items of type hts_classification (tariff-sync/sync.ts owns
// the tariff_measure_revision item type the same way), so queue state and
// projections cannot drift. applyReviewDecision/updatePartHts expect to run
// inside a transaction (routes pass a tx; the seed passes its standalone
// db); classifyPart manages its own — the model call must run OUTSIDE any
// transaction (see the note on the function).
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, isNull } from "drizzle-orm";

import { reauditEntriesForPart, type ReauditSummary } from "../audit/auditor";
import * as schema from "../db/schema";
import { normalizeHts } from "../duty/calculator";
import { loadReferenceData, type DbClient } from "../duty/reference";
import { planCommitWindow } from "../effective-dating";
import { getClassifier } from "./index";
import {
  applyReviewAction,
  assertValidCommitCode,
  deriveInitialReview,
  type ReviewActionInput,
  type ReviewKind,
} from "./review";

/** The route maps this to a 409 — the item moved under the caller. */
export class ReviewConflictError extends Error {}

export type ReviewProposal = {
  kind: ReviewKind;
  sku: string;
  partName: string;
  currentCode: string | null;
  suggestedCode: string | null;
  outcome: string;
  confidence: number | null;
  candidateCount: number;
};

const committedCodeOf = (part: schema.Part): string | null =>
  part.htsCodeProvisional ? null : part.htsCode;

/** Maintain the part's effective-dated classification windows alongside the
 *  parts.hts_code projection. A null effectiveDate is a CORRECTION ("this
 *  code was always right") and rewrites the current window in place; a date
 *  is a RECLASSIFICATION and tiles a new window from that day, closing the
 *  predecessor at day − 1. Returns true when a window row was written —
 *  the precise re-audit trigger, since a backdated tile changes historical
 *  as-of expectations even when the current code also moves. */
async function commitClassificationWindow(
  db: DbClient,
  orgId: string,
  partId: string,
  code: string,
  effectiveDate: string | null,
  meta: {
    source: string;
    actor?: string | null;
    note?: string | null;
    reviewItemId?: string | null;
  },
): Promise<boolean> {
  const current = await db.query.partClassifications.findFirst({
    where: and(
      eq(schema.partClassifications.partId, partId),
      isNull(schema.partClassifications.validTo),
    ),
  });

  if (current && normalizeHts(current.htsCode) === normalizeHts(code)) {
    return false; // Same committed code — nothing to record.
  }

  const rowMeta = {
    source: meta.source,
    actor: meta.actor ?? null,
    note: meta.note ?? null,
    reviewItemId: meta.reviewItemId ?? null,
  };
  const plan = planCommitWindow(current ?? null, effectiveDate);
  if (plan.action === "update_in_place") {
    await db
      .update(schema.partClassifications)
      .set({ htsCode: code, ...rowMeta, updatedAt: new Date() })
      .where(eq(schema.partClassifications.id, current!.id));
    return true;
  }
  if (plan.action === "tile") {
    await db
      .update(schema.partClassifications)
      .set({ validTo: plan.closePredecessorAt, updatedAt: new Date() })
      .where(eq(schema.partClassifications.id, current!.id));
  }
  await db.insert(schema.partClassifications).values({
    orgId,
    partId,
    htsCode: code,
    validFrom: plan.action === "insert_first" ? plan.validFrom : effectiveDate,
    validTo: null,
    ...rowMeta,
  });
  return true;
}

export async function classifyPart(
  db: DbClient,
  orgId: string,
  partId: string,
): Promise<{
  classification: schema.HtsClassification;
  reviewItem: schema.ReviewItem | null;
} | null> {
  // Reads and the model call run on the plain handle — the classifier can
  // take up to its 120s deadline, and a pooled connection must not sit in
  // an open transaction for it (same contract as analysis/service.ts: the
  // model runs OUTSIDE any transaction; only the writes are transactional).
  const part = await db.query.parts.findFirst({
    where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
    with: {
      sources: {
        columns: { countryOfOrigin: true },
        // Classifier input is the part as sourced TODAY: current windows only.
        where: (s, { isNull: isNullOp }) => isNullOp(s.validTo),
      },
    },
  });
  if (!part) return null;

  const ref = await loadReferenceData(db);
  const input = {
    sku: part.sku,
    name: part.name,
    description: part.description,
    countriesOfOrigin: [
      ...new Set(
        part.sources
          .map((s) => s.countryOfOrigin)
          .filter((c): c is string => c !== null),
      ),
    ].sort(),
    currentHtsCode: committedCodeOf(part),
  };
  const result = await getClassifier().classify(input, ref);

  return db.transaction(async (tx) => {
    // The part may have moved (or vanished) during the model call — commit
    // review state against its CURRENT row. `input` stays the pre-call
    // snapshot: it records what the classifier actually saw.
    const fresh = await tx.query.parts.findFirst({
      where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
    });
    if (!fresh) return null;
    const committedCode = committedCodeOf(fresh);

    const [classification] = await tx
      .insert(schema.htsClassifications)
      .values({
        orgId,
        partId,
        status: "completed",
        outcome: result.outcome,
        classifier: result.classifier,
        confidence: result.candidates[0]?.confidence.toFixed(4) ?? null,
        reasoning: result.reasoning,
        input,
      })
      .returning();

    if (result.candidates.length > 0) {
      await tx.insert(schema.htsClassificationCandidates).values(
        result.candidates.map((c, i) => ({
          orgId,
          classificationId: classification.id,
          code: c.code,
          codeDigits: c.codeDigits,
          description: ref.htsByDigits.get(c.codeDigits)?.description ?? null,
          confidence: c.confidence.toFixed(4),
          reason: c.reason,
          position: i,
        })),
      );
    }

    // A newer classification replaces whatever was awaiting review.
    await tx
      .update(schema.reviewItems)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(schema.reviewItems.itemType, "hts_classification"),
          eq(schema.reviewItems.subjectId, partId),
          eq(schema.reviewItems.status, "pending"),
        ),
      );

    const initial = deriveInitialReview(
      result,
      committedCode === null ? null : normalizeHts(committedCode),
    );
    if (!initial) {
      return { classification, reviewItem: null };
    }

    if (initial.autoSelectProvisional) {
      const code = result.candidates[0].code;
      await tx
        .update(schema.parts)
        .set({ htsCode: code, htsCodeProvisional: true, updatedAt: new Date() })
        .where(eq(schema.parts.id, partId));
      await tx.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: partId,
        field: "hts_code",
        oldValue: fresh.htsCode,
        newValue: code,
        source: "classify:auto_provisional",
      });
    }

    const primary = result.candidates[0] ?? null;
    const proposal: ReviewProposal = {
      kind: initial.kind,
      sku: fresh.sku,
      partName: fresh.name,
      currentCode: committedCode,
      suggestedCode: primary?.code ?? null,
      outcome: result.outcome,
      confidence: primary?.confidence ?? null,
      candidateCount: result.candidates.length,
    };
    const [reviewItem] = await tx
      .insert(schema.reviewItems)
      .values({
        orgId,
        itemType: "hts_classification",
        subjectId: partId,
        payloadId: classification.id,
        proposal,
      })
      .returning();

    await tx
      .update(schema.parts)
      .set({ htsReviewStatus: initial.partStatus, updatedAt: new Date() })
      .where(eq(schema.parts.id, partId));

    return { classification, reviewItem };
  });
}

export type ReviewDecisionResult = {
  part: schema.Part;
  item: schema.ReviewItem;
  reaudit: ReauditSummary | null;
};

export async function applyReviewDecision(
  db: DbClient,
  orgId: string,
  itemId: string,
  input: ReviewActionInput,
  opts: { actor?: string; notes?: string; effectiveDate?: string | null } = {},
): Promise<ReviewDecisionResult | null> {
  const item = await db.query.reviewItems.findFirst({
    where: and(
      eq(schema.reviewItems.id, itemId),
      eq(schema.reviewItems.orgId, orgId),
    ),
  });
  if (!item || item.itemType !== "hts_classification") return null;

  const expectedStatus = input.action === "reopen" ? "rejected" : "pending";
  if (item.status !== expectedStatus) {
    throw new ReviewConflictError(
      `This review item is ${item.status}; ${input.action} needs a ${expectedStatus} item. Refresh and retry.`,
    );
  }

  const part = await db.query.parts.findFirst({
    where: eq(schema.parts.id, item.subjectId),
  });
  if (!part) {
    throw new ReviewConflictError("The part behind this item no longer exists.");
  }

  const proposal = item.proposal as ReviewProposal;
  const kind: ReviewKind =
    proposal.kind === "confirmation" ? "confirmation" : "suggestion";

  const effect = applyReviewAction(
    {
      partStatus:
        part.htsReviewStatus ?? (kind === "confirmation" ? "confirmed" : "pending"),
      provisional: part.htsCodeProvisional,
      kind,
    },
    input,
  );

  const beforeCommitted = committedCodeOf(part);

  const partPatch: Partial<typeof schema.parts.$inferInsert> = {
    htsReviewStatus: effect.nextPartStatus,
    updatedAt: new Date(),
  };
  if (effect.commitCode !== null) {
    partPatch.htsCode = effect.commitCode;
    partPatch.htsCodeProvisional = false;
  } else if (effect.clearProvisional) {
    partPatch.htsCode = null;
    partPatch.htsCodeProvisional = false;
  }
  const [updatedPart] = await db
    .update(schema.parts)
    .set(partPatch)
    .where(eq(schema.parts.id, part.id))
    .returning();

  // A cleared provisional needs no window work: provisional codes never
  // created one (review.ts guarantees no committed code existed).
  const windowWritten =
    effect.commitCode !== null &&
    (await commitClassificationWindow(
      db,
      orgId,
      part.id,
      effect.commitCode,
      opts.effectiveDate ?? null,
      {
        source:
          input.action === "manual"
            ? "review:manual"
            : input.action === "accept"
              ? "review:accept"
              : "review:reject",
        actor: opts.actor,
        note: opts.notes,
        reviewItemId: item.id,
      },
    ));

  if (effect.commitCode !== null && item.payloadId) {
    await db
      .update(schema.htsClassificationCandidates)
      .set({ selected: true, updatedAt: new Date() })
      .where(
        and(
          eq(schema.htsClassificationCandidates.classificationId, item.payloadId),
          eq(
            schema.htsClassificationCandidates.codeDigits,
            normalizeHts(effect.commitCode),
          ),
        ),
      );
  }

  const [updatedItem] = await db
    .update(schema.reviewItems)
    .set(
      input.action === "reopen"
        ? {
            status: "pending",
            resolutionAction: null,
            decidedBy: null,
            decidedAt: null,
            notes: opts.notes ?? item.notes,
            updatedAt: new Date(),
          }
        : {
            status: effect.nextItemStatus,
            resolutionAction: input.action,
            decidedBy: opts.actor ?? null,
            decidedAt: new Date(),
            notes: opts.notes ?? item.notes,
            updatedAt: new Date(),
          },
    )
    .where(eq(schema.reviewItems.id, item.id))
    .returning();

  const afterCommitted = committedCodeOf(updatedPart);
  if ((part.htsCode ?? null) !== (updatedPart.htsCode ?? null)) {
    await db.insert(schema.fieldChanges).values({
      orgId,
      entityType: "part",
      entityId: part.id,
      field: "hts_code",
      oldValue: part.htsCode,
      newValue: updatedPart.htsCode,
      source:
        input.action === "manual"
          ? "review:manual"
          : input.action === "accept"
            ? "review:accept"
            : "review:reject",
      actor: opts.actor ?? null,
      note: opts.notes ?? null,
      reviewItemId: item.id,
    });
  }

  // Re-audit when the classification history changed (a window write covers
  // backdated tiles, which move historical as-of expectations) or when the
  // code the auditor sees today changed. A cleared provisional was already
  // invisible to it.
  const reaudit =
    windowWritten ||
    normalizeCommitted(beforeCommitted) !== normalizeCommitted(afterCommitted)
      ? await reauditEntriesForPart(db, orgId, part.id)
      : null;

  return { part: updatedPart, item: updatedItem, reaudit };
}

export async function updatePartHts(
  db: DbClient,
  orgId: string,
  partId: string,
  code: string,
  opts: { actor?: string; note?: string; effectiveDate?: string | null } = {},
): Promise<{ part: schema.Part; reaudit: ReauditSummary | null } | null> {
  assertValidCommitCode(code);

  const part = await db.query.parts.findFirst({
    where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
  });
  if (!part) return null;

  const beforeCommitted = committedCodeOf(part);
  const windowWritten = await commitClassificationWindow(
    db,
    orgId,
    partId,
    code,
    opts.effectiveDate ?? null,
    { source: "manual_edit", actor: opts.actor, note: opts.note },
  );

  const [updatedPart] = await db
    .update(schema.parts)
    .set({
      htsCode: code,
      htsCodeProvisional: false,
      // A direct edit is a human commitment; never downgrade a null (never
      // classified) to a review status out of thin air.
      htsReviewStatus: part.htsReviewStatus === null ? null : "accepted",
      updatedAt: new Date(),
    })
    .where(eq(schema.parts.id, partId))
    .returning();

  // The edit supersedes whatever the queue was asking about.
  await db
    .update(schema.reviewItems)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(schema.reviewItems.itemType, "hts_classification"),
        eq(schema.reviewItems.subjectId, partId),
        eq(schema.reviewItems.status, "pending"),
      ),
    );

  if ((part.htsCode ?? null) !== code || part.htsCodeProvisional) {
    await db.insert(schema.fieldChanges).values({
      orgId,
      entityType: "part",
      entityId: partId,
      field: "hts_code",
      oldValue: part.htsCode,
      newValue: code,
      source: "manual_edit",
      actor: opts.actor ?? null,
      note: opts.note ?? null,
    });
  }

  const reaudit =
    windowWritten ||
    normalizeCommitted(beforeCommitted) !== normalizeCommitted(code)
      ? await reauditEntriesForPart(db, orgId, partId)
      : null;

  return { part: updatedPart, reaudit };
}

const normalizeCommitted = (code: string | null): string | null =>
  code === null ? null : normalizeHts(code);
