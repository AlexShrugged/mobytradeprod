// Applies APPROVED revisions to the Chapter 99 reference tables — the only
// path that turns staged revisions into live measures. Window tiling: a
// successor window closes its predecessor at effective − 1 day, so windows
// never overlap and historical entries keep auditing against the rates of
// their day. Callers re-audit after an apply (sweepAudits) — expected
// charges self-heal on read, but audit_alerts persist and must be
// re-derived.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray } from "drizzle-orm";

import * as schema from "../db/schema";
import { normalizeHts } from "../duty/calculator";
import { dayBefore } from "../effective-dating";
import type { DbClient } from "../duty/reference";
import type { LiveMeasureSnapshot, ProposedMeasureChange } from "./types";

export class ApplyValidationError extends Error {}

export type RevisionApplyPlan =
  | { action: "insert_new" }
  | { action: "tile"; closePredecessorAt: string }
  | { action: "update_in_place" }
  | { action: "end"; endDate: string };

/** Pure tiling decision, test-pinned. `live` is the current window of the
 *  revision's target measure (null for create_measure). */
export function planRevisionApply(
  changeType: schema.RevisionChangeTypeValue,
  proposed: ProposedMeasureChange,
  live: Pick<LiveMeasureSnapshot, "effectiveDate" | "endDate"> | null,
  fallbackEndDate: string | null,
): RevisionApplyPlan {
  if (changeType === "create_measure") {
    if (!proposed.effectiveDate) {
      throw new ApplyValidationError(
        "A new measure needs an effective date before it can be applied.",
      );
    }
    if (!proposed.exemption && proposed.rate === null) {
      throw new ApplyValidationError(
        "A new non-exemption measure needs a rate before it can be applied.",
      );
    }
    return { action: "insert_new" };
  }

  if (changeType === "end_measure") {
    const endDate = proposed.endDate ?? fallbackEndDate;
    if (!endDate) {
      throw new ApplyValidationError(
        "Ending a measure needs an end date (or an announcement published date).",
      );
    }
    return { action: "end", endDate };
  }

  if (changeType === "stacking_change") {
    throw new ApplyValidationError(
      "Stacking changes are staged for visibility but not yet appliable.",
    );
  }

  // rate_change / scope_change / note_change
  if (!live) {
    throw new ApplyValidationError(
      "The measure this revision targets no longer exists.",
    );
  }
  if (!proposed.effectiveDate) {
    throw new ApplyValidationError(
      "A rate/scope change needs the successor window's effective date.",
    );
  }
  if (proposed.rate === null && !proposed.exemption) {
    throw new ApplyValidationError("A rate change needs the new rate.");
  }
  if (proposed.effectiveDate > live.effectiveDate) {
    return { action: "tile", closePredecessorAt: dayBefore(proposed.effectiveDate) };
  }
  // Same-or-earlier effective date: a correction of the current window.
  return { action: "update_in_place" };
}

// Moved to the shared effective-dating module; re-exported for existing
// importers (base-apply, tests).
export { dayBefore };

export type ApplyResult = {
  applied: number;
  /** The measure windows this apply created or re-dated — the impact
   *  report evaluates in-transit shipments against exactly these. */
  changedMeasureIds: string[];
  errors: { revisionId: string; error: string }[];
};

export async function applyAnnouncement(
  db: DbClient,
  orgId: string,
  announcementId: string,
): Promise<ApplyResult | null> {
  const announcement = await db.query.tariffAnnouncements.findFirst({
    where: eq(schema.tariffAnnouncements.id, announcementId),
  });
  if (!announcement) return null;

  const revisions = await db.query.measureRevisions.findMany({
    where: eq(schema.measureRevisions.announcementId, announcementId),
  });
  const items = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_revision"),
      inArray(
        schema.reviewItems.subjectId,
        revisions.length > 0 ? revisions.map((r) => r.id) : ["-"],
      ),
    ),
  });
  const itemByRevision = new Map(items.map((i) => [i.subjectId, i]));

  const result: ApplyResult = { applied: 0, changedMeasureIds: [], errors: [] };

  for (const rev of revisions) {
    const item = itemByRevision.get(rev.id);
    if (rev.appliedAt || item?.status !== "approved") continue;

    const proposed = rev.proposed as ProposedMeasureChange;
    try {
      const applied = await applyOne(db, rev, proposed, announcement);
      await db
        .update(schema.measureRevisions)
        .set({
          appliedAt: new Date(),
          appliedMeasureId: applied.measureId,
          updatedAt: new Date(),
        })
        .where(eq(schema.measureRevisions.id, rev.id));
      result.applied += 1;
      if (applied.measureId) result.changedMeasureIds.push(applied.measureId);
    } catch (err) {
      if (err instanceof ApplyValidationError) {
        result.errors.push({ revisionId: rev.id, error: err.message });
      } else {
        throw err;
      }
    }
  }

  await resolveAnnouncementIfTerminal(db, announcementId);
  return result;
}

/** Apply ONE approved revision — mobytrade's review queue approves and
 *  applies in a single step (PATCH /api/tariff-sync/revisions/[id]), so a
 *  reviewer's confirmation lands immediately instead of parking in an
 *  "approved, unapplied" state. Caller wraps this in a transaction and
 *  re-audits afterwards. Throws ApplyValidationError when the proposal is
 *  incomplete; returns null when the revision does not exist. */
export async function applyRevision(
  db: DbClient,
  revisionId: string,
): Promise<{ measureId: string | null } | null> {
  const rev = await db.query.measureRevisions.findFirst({
    where: eq(schema.measureRevisions.id, revisionId),
  });
  if (!rev) return null;
  if (rev.appliedAt) {
    throw new ApplyValidationError("This revision was already applied.");
  }

  const item = await db.query.reviewItems.findFirst({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_revision"),
      eq(schema.reviewItems.subjectId, revisionId),
    ),
  });
  if (item?.status !== "approved") {
    throw new ApplyValidationError(
      "Only an approved revision can be applied.",
    );
  }

  const announcement = await db.query.tariffAnnouncements.findFirst({
    where: eq(schema.tariffAnnouncements.id, rev.announcementId),
  });
  if (!announcement) return null;

  const applied = await applyOne(
    db,
    rev,
    rev.proposed as ProposedMeasureChange,
    announcement,
  );
  await db
    .update(schema.measureRevisions)
    .set({
      appliedAt: new Date(),
      appliedMeasureId: applied.measureId,
      updatedAt: new Date(),
    })
    .where(eq(schema.measureRevisions.id, revisionId));

  await resolveAnnouncementIfTerminal(db, rev.announcementId);
  return applied;
}

/** Resolved when every revision is terminal: applied, or its queue item was
 *  rejected/superseded. A pending decision or a failed apply keeps the
 *  announcement open. Re-queries, so it sees in-transaction updates. */
export async function resolveAnnouncementIfTerminal(
  db: DbClient,
  announcementId: string,
): Promise<void> {
  const revisions = await db.query.measureRevisions.findMany({
    where: eq(schema.measureRevisions.announcementId, announcementId),
  });
  if (revisions.length === 0) return;

  const items = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_revision"),
      inArray(
        schema.reviewItems.subjectId,
        revisions.map((r) => r.id),
      ),
    ),
  });
  const itemByRevision = new Map(items.map((i) => [i.subjectId, i]));

  const allTerminal = revisions.every((rev) => {
    if (rev.appliedAt !== null) return true;
    const status = itemByRevision.get(rev.id)?.status;
    return status === "rejected" || status === "superseded";
  });
  if (allTerminal) {
    await db
      .update(schema.tariffAnnouncements)
      .set({ status: "resolved", updatedAt: new Date() })
      .where(eq(schema.tariffAnnouncements.id, announcementId));
  }
}

async function applyOne(
  db: DbClient,
  rev: schema.MeasureRevision,
  proposed: ProposedMeasureChange,
  announcement: schema.TariffAnnouncement,
): Promise<{ measureId: string | null }> {
  const live = rev.targetMeasureId
    ? await db.query.tradeMeasures.findFirst({
        where: eq(schema.tradeMeasures.id, rev.targetMeasureId),
      })
    : undefined;

  const plan = planRevisionApply(
    rev.changeType,
    proposed,
    live ? { effectiveDate: live.effectiveDate, endDate: live.endDate } : null,
    announcement.publishedDate,
  );

  const measureValues = {
    name: proposed.name,
    authority: proposed.authority,
    scope: proposed.scope,
    countries: proposed.countries,
    effectiveDate: proposed.effectiveDate!,
    endDate: proposed.endDate,
    sailedOnOrAfter: proposed.sailedOnOrAfter,
    sailedOnOrBefore: proposed.sailedOnOrBefore,
    inLieuOfBaseDuty: proposed.inLieuOfBaseDuty,
    notes: proposed.notes,
  };

  switch (plan.action) {
    case "insert_new": {
      const [measure] = await db
        .insert(schema.tradeMeasures)
        .values(measureValues)
        .returning();
      await insertCh99Row(db, rev.ch99Code!, proposed, measure.id);
      await insertPrefixes(db, measure.id, proposed.prefixes);
      return { measureId: measure.id };
    }

    case "tile": {
      // Close the predecessor only if it is open past the successor start.
      if (live!.endDate === null || live!.endDate >= proposed.effectiveDate!) {
        await db
          .update(schema.tradeMeasures)
          .set({ endDate: plan.closePredecessorAt, updatedAt: new Date() })
          .where(eq(schema.tradeMeasures.id, live!.id));
      }
      const [successor] = await db
        .insert(schema.tradeMeasures)
        .values({ ...measureValues, predecessorId: live!.id })
        .returning();
      await insertCh99Row(db, rev.ch99Code!, proposed, successor.id);
      // The successor inherits the predecessor's exemption codes — an
      // in-transit exception outlives a rate change.
      const exemptionRows = await db.query.htsCodes.findMany({
        where: and(
          eq(schema.htsCodes.tradeMeasureId, live!.id),
          eq(schema.htsCodes.exemption, true),
        ),
      });
      for (const ex of exemptionRows) {
        await db.insert(schema.htsCodes).values({
          code: ex.code,
          codeDigits: ex.codeDigits,
          description: ex.description,
          chapter: 99,
          rateType: ex.rateType,
          rate: ex.rate,
          tradeMeasureId: successor.id,
          exemption: true,
        });
      }
      await insertPrefixes(db, successor.id, proposed.prefixes);
      return { measureId: successor.id };
    }

    case "update_in_place": {
      await db
        .update(schema.tradeMeasures)
        .set({ ...measureValues, updatedAt: new Date() })
        .where(eq(schema.tradeMeasures.id, live!.id));
      if (!proposed.exemption && proposed.rate !== null && rev.ch99Code) {
        await db
          .update(schema.htsCodes)
          .set({ rate: proposed.rate.toFixed(6), updatedAt: new Date() })
          .where(
            and(
              eq(schema.htsCodes.codeDigits, normalizeHts(rev.ch99Code)),
              eq(schema.htsCodes.tradeMeasureId, live!.id),
            ),
          );
      }
      return { measureId: live!.id };
    }

    case "end": {
      await db
        .update(schema.tradeMeasures)
        .set({ endDate: plan.endDate, updatedAt: new Date() })
        .where(eq(schema.tradeMeasures.id, live!.id));
      return { measureId: live!.id };
    }
  }
}

async function insertCh99Row(
  db: DbClient,
  ch99Code: string,
  proposed: ProposedMeasureChange,
  measureId: string,
): Promise<void> {
  await db.insert(schema.htsCodes).values({
    code: ch99Code,
    codeDigits: normalizeHts(ch99Code),
    description: proposed.name,
    chapter: 99,
    rateType: "ad_valorem",
    rate: proposed.exemption ? "0.000000" : proposed.rate!.toFixed(6),
    tradeMeasureId: measureId,
    exemption: proposed.exemption,
  });
}

async function insertPrefixes(
  db: DbClient,
  measureId: string,
  prefixes: string[],
): Promise<void> {
  if (prefixes.length === 0) return;
  await db.insert(schema.tradeMeasureHts).values(
    prefixes.map((htsPrefix) => ({ tradeMeasureId: measureId, htsPrefix })),
  );
}
