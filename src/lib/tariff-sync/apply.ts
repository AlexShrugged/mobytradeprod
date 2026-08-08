// Applies APPROVED revisions to the Chapter 99 reference tables — the only
// path that turns staged revisions into live measures. Window tiling: a
// successor window closes its predecessor at effective − 1 day, so windows
// never overlap and historical entries keep auditing against the rates of
// their day. Callers re-audit after an apply (sweepAudits) — expected
// charges self-heal on read, but audit_alerts persist and must be
// re-derived.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray, isNull } from "drizzle-orm";

import * as schema from "../db/schema";
import { normalizeHts } from "../duty/calculator";
import { dayBefore } from "../effective-dating";
import type { DbClient } from "../duty/reference";
import type {
  LiveMeasureSnapshot,
  ProposedMeasureChange,
  RevisionProposalDisplay,
} from "./types";

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
    // Non-ad-valorem (specific/compound) measures legitimately carry a null
    // rate — they apply presence-only. Ad-valorem ones need the number.
    if (
      !proposed.exemption &&
      proposed.rate === null &&
      (proposed.rateType ?? "ad_valorem") === "ad_valorem"
    ) {
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
  if (
    proposed.rate === null &&
    !proposed.exemption &&
    (proposed.rateType ?? "ad_valorem") === "ad_valorem"
  ) {
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

/** Resolved when every revision is terminal: applied, superseded (the
 *  timestamp — grouped members have no own queue item), or its gate was
 *  rejected/superseded (the per-revision item for individual revisions,
 *  the group's item for grouped members). A pending decision or a failed
 *  apply keeps the announcement open. Re-queries, so it sees
 *  in-transaction updates. */
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

  const groupIds = [
    ...new Set(
      revisions
        .map((r) => r.groupId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const groupItems =
    groupIds.length > 0
      ? await db.query.reviewItems.findMany({
          where: and(
            eq(schema.reviewItems.itemType, "tariff_measure_group"),
            inArray(schema.reviewItems.subjectId, groupIds),
          ),
          orderBy: (t, { asc }) => [asc(t.createdAt)],
        })
      : [];
  // Latest item per group wins (history rows possible after re-stages).
  const groupItemByGroup = new Map<string, (typeof groupItems)[number]>();
  for (const item of groupItems) groupItemByGroup.set(item.subjectId, item);

  const allTerminal = revisions.every((rev) => {
    if (rev.appliedAt !== null || rev.supersededAt !== null) return true;
    const gate = rev.groupId
      ? groupItemByGroup.get(rev.groupId)
      : itemByRevision.get(rev.id);
    return gate?.status === "rejected" || gate?.status === "superseded";
  });
  if (allTerminal) {
    await db
      .update(schema.tariffAnnouncements)
      .set({ status: "resolved", updatedAt: new Date() })
      .where(eq(schema.tariffAnnouncements.id, announcementId));
  }
}

export type GroupApplyResult = {
  groupId: string;
  applied: number;
  /** Unchecked members — REJECTED, finalized by the same approve action.
   *  Each gets its own rejected review item (decision record), so the
   *  family always fully resolves in one action: checked → applied,
   *  unchecked → rejected. A rejected code re-stages automatically if it
   *  still exists in USITC's next release. */
  rejected: number;
  changedMeasureIds: string[];
};

/** Apply one approved adoption group, ALL-OR-NOTHING: any member that fails
 *  validation aborts the whole apply (throwing rolls the caller's
 *  transaction back, approval included) with the failing codes listed, so
 *  no member is ever stranded unapplied inside an approved group. The
 *  reviewer's outs are opts.defaultEffectiveDate (folded into members whose
 *  proposed date is still null — persisted, so what applied is recorded)
 *  and opts.skipRevisionIds (excluded members, stamped superseded).
 *  Returns null when the group does not exist. */
export async function applyRevisionGroup(
  db: DbClient,
  groupId: string,
  opts: {
    defaultEffectiveDate?: string;
    /** Folded into members whose proposed endDate is still null — bulk
     *  adoption of an already-terminated family (e.g. the IEEPA reciprocal
     *  headings) must not mint open-ended windows. */
    defaultEndDate?: string;
    /** Per-member reviewer-confirmed effective dates, keyed by revision id
     *  — the date window is the ONE field the feed never carries, and
     *  members of a family legitimately differ (later bilateral deals,
     *  amendments). Overrides the proposal; the default fills what's left. */
    memberEffectiveDates?: Record<string, string>;
    /** Unchecked members — rejected as part of this approval. */
    skipRevisionIds?: string[];
    /** Actor recorded on the per-member rejection items. */
    decidedBy?: string;
  } = {},
): Promise<GroupApplyResult | null> {
  const group = await db.query.measureRevisionGroups.findFirst({
    where: eq(schema.measureRevisionGroups.id, groupId),
  });
  if (!group) return null;

  const item = await db.query.reviewItems.findFirst({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_group"),
      eq(schema.reviewItems.subjectId, groupId),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  if (item?.status !== "approved") {
    throw new ApplyValidationError(
      "Only an approved adoption group can be applied.",
    );
  }

  const announcement = await db.query.tariffAnnouncements.findFirst({
    where: eq(schema.tariffAnnouncements.id, group.announcementId),
  });
  if (!announcement) return null;

  const members = await db.query.measureRevisions.findMany({
    where: and(
      eq(schema.measureRevisions.groupId, groupId),
      isNull(schema.measureRevisions.appliedAt),
      isNull(schema.measureRevisions.supersededAt),
    ),
    orderBy: (t, { asc }) => [asc(t.ch99Code)],
  });

  const skips = new Set(opts.skipRevisionIds ?? []);
  const result: GroupApplyResult = {
    groupId,
    applied: 0,
    rejected: 0,
    changedMeasureIds: [],
  };
  const failures: { ch99Code: string | null; error: string }[] = [];

  for (const rev of members) {
    if (skips.has(rev.id)) {
      // Unchecked = rejected, finalized by this approval. Detach from the
      // group (its item is about to read "approved") and record the
      // rejection as a per-revision item — the same terminal state an
      // individually rejected revision gets.
      await db
        .update(schema.measureRevisions)
        .set({ groupId: null, updatedAt: new Date() })
        .where(eq(schema.measureRevisions.id, rev.id));
      const revProposed = rev.proposed as ProposedMeasureChange;
      const display: RevisionProposalDisplay = {
        changeType: rev.changeType,
        ch99Code: rev.ch99Code,
        authority: rev.authority,
        name: revProposed.name,
        rateBefore: (rev.liveSnapshot as LiveMeasureSnapshot | null)?.rate ?? null,
        rateAfter: revProposed.rate,
        source: announcement.source,
        sourceRef: announcement.sourceRef,
        announcementTitle: announcement.title,
      };
      await db.insert(schema.reviewItems).values({
        itemType: "tariff_measure_revision",
        subjectId: rev.id,
        payloadId: rev.id,
        proposal: display,
        status: "rejected",
        resolutionAction: "reject",
        decidedBy: opts.decidedBy ?? null,
        decidedAt: new Date(),
      });
      result.rejected += 1;
      continue;
    }

    const proposed = { ...(rev.proposed as ProposedMeasureChange) };
    let folded = false;
    const memberDate = opts.memberEffectiveDates?.[rev.id];
    if (memberDate && memberDate !== proposed.effectiveDate) {
      proposed.effectiveDate = memberDate;
      folded = true;
    }
    if (!proposed.effectiveDate && opts.defaultEffectiveDate) {
      proposed.effectiveDate = opts.defaultEffectiveDate;
      folded = true;
    }
    if (!proposed.endDate && opts.defaultEndDate) {
      proposed.endDate = opts.defaultEndDate;
      folded = true;
    }
    if (folded) {
      await db
        .update(schema.measureRevisions)
        .set({ proposed, updatedAt: new Date() })
        .where(eq(schema.measureRevisions.id, rev.id));
    }

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
        failures.push({ ch99Code: rev.ch99Code, error: err.message });
      } else {
        throw err;
      }
    }
  }

  if (failures.length > 0) {
    const shown = failures
      .slice(0, 5)
      .map((f) => `${f.ch99Code ?? "?"}: ${f.error}`)
      .join(" · ");
    throw new ApplyValidationError(
      `${failures.length} member(s) failed validation — nothing was applied. ${shown}` +
        (failures.length > 5 ? ` (+${failures.length - 5} more)` : "") +
        " Set a default effective date or uncheck the failing codes, then retry.",
    );
  }

  await resolveAnnouncementIfTerminal(db, group.announcementId);
  return result;
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
    countriesExcluded: proposed.countriesExcluded ?? null,
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
      if (!proposed.exemption && rev.ch99Code) {
        await db
          .update(schema.htsCodes)
          .set({
            rate: proposed.rate === null ? null : proposed.rate.toFixed(6),
            rateType: proposed.rateType ?? "ad_valorem",
            col1General: proposed.rateText ?? null,
            updatedAt: new Date(),
          })
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
    rateType: proposed.rateType ?? "ad_valorem",
    // Null rate = non-ad-valorem, presence-only; the raw text goes to
    // col1General for display, mirroring base-schedule rows.
    rate: proposed.exemption
      ? "0.000000"
      : proposed.rate === null
        ? null
        : proposed.rate.toFixed(6),
    col1General: proposed.rateText ?? null,
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
