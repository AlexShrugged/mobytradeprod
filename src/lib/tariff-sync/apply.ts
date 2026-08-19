// Applies APPROVED revisions to the Chapter 99 reference tables — the only
// path that turns staged revisions into live measures. Window tiling: a
// successor window closes its predecessor at effective − 1 day, so windows
// never overlap and historical entries keep auditing against the rates of
// their day. Callers re-audit after an apply (sweepAudits) — expected
// charges self-heal on read, but audit_alerts persist and must be
// re-derived.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray, isNotNull, isNull, like } from "drizzle-orm";

import * as schema from "../db/schema";
import { normalizeHts } from "../duty/calculator";
import { dayBefore } from "../effective-dating";
import type { DbClient } from "../duty/reference";
import {
  findProgramConflicts,
  inferProgram,
  planProgramResolution,
  type LiveProgramMeasure,
} from "./programs";
import type {
  LiveMeasureSnapshot,
  ProposedMeasureChange,
  RevisionEvidence,
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
    // Null countries means EVERY country of origin — too big a blast radius
    // to fail open on (unparsed per-country headings used to mint worldwide
    // measures this way). The reviewer either sets countries or explicitly
    // confirms worldwide scope.
    if (
      !proposed.exemption &&
      proposed.countries === null &&
      proposed.worldwide !== true
    ) {
      throw new ApplyValidationError(
        "Confirm the country scope: set countries of origin, or explicitly " +
          "mark the measure as applying to every country.",
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
): Promise<{ measureId: string | null; superseded: SupersededMeasure[] } | null> {
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
  /** Live measures whose windows this apply closed (auto-supersede),
   *  reported back to the reviewer's toast. */
  superseded: SupersededMeasure[];
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
    /** Per-member program overrides (revision id → slug or null to clear)
     *  — corrections to the differ's inference. */
    memberPrograms?: Record<string, string | null>;
    /** Reviewer's blanket confirmation that members with null countries
     *  really apply to every country of origin (the family-level answer to
     *  the per-measure worldwide gate). */
    confirmWorldwide?: boolean;
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
    superseded: [],
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
    const memberProgram = opts.memberPrograms?.[rev.id];
    if (memberProgram !== undefined && memberProgram !== proposed.program) {
      proposed.program = memberProgram;
      folded = true;
    }
    // Members staged before program inference existed (absent field, not an
    // explicit null): derive the program exactly as staging now does, so
    // pre-feature queues get the same conflict gates. Persisted like the
    // date folds — what applied is recorded — and memberPrograms above
    // still overrides.
    if (proposed.program === undefined && rev.changeType === "create_measure") {
      proposed.program = inferProgram(
        proposed.authority,
        rev.ch99Code ?? "",
        (rev.evidence as RevisionEvidence | null)?.description ?? "",
      );
      folded = true;
    }
    if (
      opts.confirmWorldwide &&
      proposed.countries === null &&
      proposed.worldwide !== true
    ) {
      proposed.worldwide = true;
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
      result.superseded.push(...applied.superseded);
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

/** A live measure an apply closed (window ended at successor effective − 1)
 *  because the applied measure supersedes it. Reported back to the reviewer. */
export type SupersededMeasure = {
  ch99Code: string;
  name: string;
  effectiveDate: string;
};

async function applyOne(
  db: DbClient,
  rev: schema.MeasureRevision,
  proposed: ProposedMeasureChange,
  announcement: schema.TariffAnnouncement,
): Promise<{ measureId: string | null; superseded: SupersededMeasure[] }> {
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
    // Proposals staged before the program field existed must not wipe a
    // live measure's program on tile/update — absent inherits, null clears.
    program:
      proposed.program === undefined
        ? (live?.program ?? null)
        : proposed.program,
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
      // Same-program collision gate: a new heading claiming the same
      // countries, products, and window as live measures of its program
      // SUPERSEDES them — their windows close at effective − 1, lineage
      // links to the latest. The review cards disclose the targets per
      // line before approval; the only fail-closed case left is broken
      // dates (a conflict starting on or after the proposal). Sail-
      // partitioned pairs are not conflicts — they coexist and the
      // calculator picks one per entry by sail date. Members of one group
      // apply sequentially in the same transaction, so within-batch
      // collisions are caught here too (same-date ones fail on the date
      // guard instead of silently chain-superseding). Null program =
      // lineage unknown: no gate (and the calculator never dedupes it
      // either).
      let predecessorId: string | null = null;
      const superseded: SupersededMeasure[] = [];
      if (!proposed.exemption && proposed.program) {
        const conflicts = findProgramConflicts(
          proposed,
          await loadProgramMeasures(db, proposed.program),
        );
        const resolution = planProgramResolution(proposed, conflicts);
        if (resolution.kind === "error") {
          throw new ApplyValidationError(resolution.message);
        }
        if (resolution.kind === "supersede") {
          // Every conflict overlaps the successor window, so each is open
          // past the close point — closing always shortens, never extends.
          await db
            .update(schema.tradeMeasures)
            .set({
              endDate: dayBefore(proposed.effectiveDate!),
              updatedAt: new Date(),
            })
            .where(
              inArray(schema.tradeMeasures.id, resolution.closeMeasureIds),
            );
          predecessorId = resolution.predecessorId;
          for (const c of conflicts) {
            superseded.push({
              ch99Code: c.ch99Code,
              name: c.name,
              effectiveDate: c.effectiveDate,
            });
          }
        }
      }
      const [measure] = await db
        .insert(schema.tradeMeasures)
        .values({ ...measureValues, predecessorId })
        .returning();
      await insertCh99Row(db, rev.ch99Code!, proposed, measure.id);
      await insertPrefixes(db, measure.id, proposed.prefixes);
      // Family linkage both ways: a new exemption heading must satisfy the
      // family's live liability measures, and a new liability heading must
      // carry the family's existing exemption codes (Rule 1 reads only
      // same-measure exemption rows).
      await syncFamilyExemptionLinks(db, normalizeHts(rev.ch99Code!));
      return { measureId: measure.id, superseded };
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
      // Beyond the predecessor's own rows: any family exemption codes the
      // predecessor never carried (pre-linkage windows) reach the successor
      // here. Idempotent with the inheritance above.
      await syncFamilyExemptionLinks(db, normalizeHts(rev.ch99Code!));
      return { measureId: successor.id, superseded: [] };
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
      return { measureId: live!.id, superseded: [] };
    }

    case "end": {
      await db
        .update(schema.tradeMeasures)
        .set({ endDate: plan.endDate, updatedAt: new Date() })
        .where(eq(schema.tradeMeasures.id, live!.id));
      return { measureId: live!.id, superseded: [] };
    }
  }
}

/** Live measures of one program, shaped for the pure conflict check. Unlike
 *  same-code tiling, a cross-code supersede does NOT copy the predecessor's
 *  own exemption rows — a new heading defines its own carve-outs in its
 *  notice. Family-wide exemption HEADINGS are a different thing: those are
 *  linked onto every liability measure of the 6-digit family by
 *  syncFamilyExemptionLinks (a declared $0 family exemption code is a
 *  broker's statement that satisfies the measure; it never changes duty
 *  math). */
export async function loadProgramMeasures(
  db: DbClient,
  program: string,
): Promise<LiveProgramMeasure[]> {
  const measures = await db.query.tradeMeasures.findMany({
    where: eq(schema.tradeMeasures.program, program),
  });
  if (measures.length === 0) return [];
  const ids = measures.map((m) => m.id);
  const [ch99Rows, prefixRows] = await Promise.all([
    db.query.htsCodes.findMany({
      where: inArray(schema.htsCodes.tradeMeasureId, ids),
    }),
    db.query.tradeMeasureHts.findMany({
      where: inArray(schema.tradeMeasureHts.tradeMeasureId, ids),
    }),
  ]);
  const codeByMeasure = new Map<string, string>();
  for (const h of ch99Rows) {
    if (h.exemption || !h.tradeMeasureId) continue;
    if (!codeByMeasure.has(h.tradeMeasureId)) {
      codeByMeasure.set(h.tradeMeasureId, h.code);
    }
  }
  const prefixesByMeasure = new Map<string, string[]>();
  for (const p of prefixRows) {
    const list = prefixesByMeasure.get(p.tradeMeasureId) ?? [];
    list.push(p.htsPrefix);
    prefixesByMeasure.set(p.tradeMeasureId, list);
  }
  return measures.map((m) => ({
    id: m.id,
    name: m.name,
    ch99Code: codeByMeasure.get(m.id) ?? "—",
    program: m.program,
    countries: m.countries,
    effectiveDate: m.effectiveDate,
    endDate: m.endDate,
    scope: m.scope,
    prefixes: prefixesByMeasure.get(m.id) ?? [],
    sailedOnOrAfter: m.sailedOnOrAfter,
    sailedOnOrBefore: m.sailedOnOrBefore,
  }));
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

// ---- Family exemption linkage ----------------------------------------------
// Chapter 99 headings come in 6-digit families (the same neighborhood key the
// sync's grouping uses): liability headings plus the exemption headings whose
// declaration excuses them (9903.82.01 "no aluminum/steel content" excuses
// 9903.82.02/.04/.14). Audit Rule 1's missing-measure satisfaction reads
// MeasureRef.exclusionDigits, which buildReferenceData assembles from
// exemption hts_codes rows sharing the LIABILITY measure's trade_measure_id —
// so every liability measure must carry a copy of each family exemption row.
// The sync pipeline stages each code as its own revision, so linkage is
// maintained here at apply time; scripts/repair-exemption-linkage.ts sweeps
// the same invariant across families staged before this existed.

/** One family Chapter 99 row, as fed to the pure planner. */
export type FamilyCh99Row = {
  id: string;
  code: string;
  codeDigits: string;
  description: string;
  rateType: schema.HtsRateTypeValue;
  exemption: boolean;
  tradeMeasureId: string | null;
  /** Cross-program carve-out trigger — copied with the exemption row so
   *  every family liability measure carries the displacement. */
  carveoutTriggerProgram?: string | null;
};

export type ExemptionLinkInsert = {
  code: string;
  codeDigits: string;
  description: string;
  rateType: schema.HtsRateTypeValue;
  tradeMeasureId: string;
  carveoutTriggerProgram: string | null;
};

/** Pure planning, test-pinned: given every Chapter 99 row of ONE 6-digit
 *  family, the exemption-row copies each liability measure is missing.
 *  Metadata is copied from the lowest-id row per exemption digits (uuidv7
 *  ids sort by creation time — the original staging row). Idempotent by
 *  construction: existing (digits, measure) pairs are never re-planned. */
export function planFamilyExemptionLinks(
  rows: FamilyCh99Row[],
): ExemptionLinkInsert[] {
  const canonical = new Map<string, FamilyCh99Row>();
  const existing = new Set<string>();
  const liabilityMeasures = new Set<string>();
  for (const r of rows) {
    if (!r.tradeMeasureId) continue;
    if (r.exemption) {
      existing.add(`${r.codeDigits}:${r.tradeMeasureId}`);
      const cur = canonical.get(r.codeDigits);
      if (!cur || r.id < cur.id) canonical.set(r.codeDigits, r);
    } else {
      liabilityMeasures.add(r.tradeMeasureId);
    }
  }
  const inserts: ExemptionLinkInsert[] = [];
  for (const [codeDigits, ex] of canonical) {
    for (const tradeMeasureId of liabilityMeasures) {
      if (existing.has(`${codeDigits}:${tradeMeasureId}`)) continue;
      inserts.push({
        code: ex.code,
        codeDigits,
        description: ex.description,
        rateType: ex.rateType,
        tradeMeasureId,
        carveoutTriggerProgram: ex.carveoutTriggerProgram ?? null,
      });
    }
  }
  return inserts.sort(
    (a, b) =>
      a.codeDigits.localeCompare(b.codeDigits) ||
      a.tradeMeasureId.localeCompare(b.tradeMeasureId),
  );
}

/** Restore the family invariant for the family containing `ch99Digits`:
 *  every liability measure carries a copy of each family exemption row.
 *  Returns how many link rows were inserted. Safe to call repeatedly — the
 *  (code_digits, trade_measure_id) unique index backstops the planner's
 *  own dedupe. */
export async function syncFamilyExemptionLinks(
  db: DbClient,
  ch99Digits: string,
): Promise<number> {
  const family = ch99Digits.slice(0, 6);
  if (family.length < 6) return 0;
  const rows = await db.query.htsCodes.findMany({
    where: and(
      isNotNull(schema.htsCodes.tradeMeasureId),
      like(schema.htsCodes.codeDigits, `${family}%`),
    ),
  });
  const inserts = planFamilyExemptionLinks(rows);
  if (inserts.length === 0) return 0;
  await db
    .insert(schema.htsCodes)
    .values(
      inserts.map((i) => ({
        code: i.code,
        codeDigits: i.codeDigits,
        description: i.description,
        chapter: 99,
        rateType: i.rateType,
        rate: "0.000000",
        tradeMeasureId: i.tradeMeasureId,
        exemption: true,
        carveoutTriggerProgram: i.carveoutTriggerProgram,
      })),
    )
    .onConflictDoNothing();
  return inserts.length;
}
