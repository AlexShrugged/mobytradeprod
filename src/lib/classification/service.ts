// DB effects for the classification/review workflow — the ONLY writer of
// hts_classifications, field_changes, the parts review projection columns,
// and review_items of type hts_classification (tariff-sync/sync.ts owns
// the tariff_measure_revision item type the same way), so queue state and
// projections cannot drift. Every entry point expects to run inside a
// transaction (routes pass a tx; the seed passes its standalone db).
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq } from "drizzle-orm";

import { reauditEntriesForPart, type ReauditSummary } from "../audit/auditor";
import * as schema from "../db/schema";
import { normalizeHts } from "../duty/calculator";
import { loadReferenceData, type DbClient } from "../duty/reference";
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

export async function classifyPart(
  db: DbClient,
  orgId: string,
  partId: string,
): Promise<{
  classification: schema.HtsClassification;
  reviewItem: schema.ReviewItem | null;
} | null> {
  const part = await db.query.parts.findFirst({
    where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
  });
  if (!part) return null;

  const ref = await loadReferenceData(db);
  const committedCode = committedCodeOf(part);
  const input = {
    sku: part.sku,
    name: part.name,
    description: part.description,
    countryOfOrigin: part.countryOfOrigin,
    currentHtsCode: committedCode,
  };
  const result = await getClassifier().classify(input, ref);

  const [classification] = await db
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
    await db.insert(schema.htsClassificationCandidates).values(
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

  const initial = deriveInitialReview(
    result,
    committedCode === null ? null : normalizeHts(committedCode),
  );
  if (!initial) {
    return { classification, reviewItem: null };
  }

  if (initial.autoSelectProvisional) {
    const code = result.candidates[0].code;
    await db
      .update(schema.parts)
      .set({ htsCode: code, htsCodeProvisional: true, updatedAt: new Date() })
      .where(eq(schema.parts.id, partId));
    await db.insert(schema.fieldChanges).values({
      orgId,
      entityType: "part",
      entityId: partId,
      field: "hts_code",
      oldValue: part.htsCode,
      newValue: code,
      source: "classify:auto_provisional",
    });
  }

  const primary = result.candidates[0] ?? null;
  const proposal: ReviewProposal = {
    kind: initial.kind,
    sku: part.sku,
    partName: part.name,
    currentCode: committedCode,
    suggestedCode: primary?.code ?? null,
    outcome: result.outcome,
    confidence: primary?.confidence ?? null,
    candidateCount: result.candidates.length,
  };
  const [reviewItem] = await db
    .insert(schema.reviewItems)
    .values({
      orgId,
      itemType: "hts_classification",
      subjectId: partId,
      payloadId: classification.id,
      proposal,
    })
    .returning();

  await db
    .update(schema.parts)
    .set({ htsReviewStatus: initial.partStatus, updatedAt: new Date() })
    .where(eq(schema.parts.id, partId));

  return { classification, reviewItem };
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
  opts: { actor?: string; notes?: string } = {},
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

  // Re-audit only when the code the auditor sees actually changed. A
  // cleared provisional was already invisible to it.
  const reaudit =
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
  opts: { actor?: string; note?: string } = {},
): Promise<{ part: schema.Part; reaudit: ReauditSummary | null } | null> {
  assertValidCommitCode(code);

  const part = await db.query.parts.findFirst({
    where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
  });
  if (!part) return null;

  const beforeCommitted = committedCodeOf(part);

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
    normalizeCommitted(beforeCommitted) !== normalizeCommitted(code)
      ? await reauditEntriesForPart(db, orgId, partId)
      : null;

  return { part: updatedPart, reaudit };
}

const normalizeCommitted = (code: string | null): string | null =>
  code === null ? null : normalizeHts(code);
