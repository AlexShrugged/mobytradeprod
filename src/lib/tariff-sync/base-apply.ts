// The SOLE writer of base-schedule hts_codes windows. Base releases stage
// as ONE reviewable unit (sync.ts stageBaseRelease → a tariff_base_release
// review item); applyBaseRelease is the approval-gated path that re-derives
// the diff from the archived raw payload and writes the windows. ~30k
// objective MFN rows are not per-row review material, but a release-level
// gate is what stands between a truncated fetch and a nuked schedule.
//
// Window tiling (same rationale as Chapter 99 apply.ts): when a release
// changes a code's rate or description, the current window closes at
// effectiveDate − 1 and a successor opens at effectiveDate (valid_to null),
// so historical entries keep auditing against the base rates of their day.
// Exception: windows still stamped with the demo SEED release are admitted
// approximations, not history — a certified release CORRECTS them in place
// (planBaseChange) instead of preserving them as bogus historical windows.
// Codes absent from the release get their window closed (absence ==
// removal; USITC has no change feed); a code reappearing later simply opens
// a new window next to its closed history.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray, isNull } from "drizzle-orm";

import { auditEntry } from "../audit/auditor";
import * as schema from "../db/schema";
import { loadReferenceDataForOrg, type DbClient } from "../duty/reference";
import { planCloseDate, planWindow } from "../effective-dating";
import { getFileStore } from "../storage";
import { ApplyValidationError } from "./apply";
import { checkBaseReleaseSanity } from "./base-guard";
import { runBaseEtl } from "./base-etl";
import { loadCurrentBaseWindows } from "./state";
import { parseBaseRows } from "./usitc";
import type {
  BaseDiff,
  BaseReleaseProposalDisplay,
  CurrentBaseWindow,
  PreparedBaseRow,
} from "./types";

/** Matches seed-data/tariff.ts BASE_RELEASE — the marker on demo bootstrap
 *  rows whose rates are approximations, not certified USITC values. */
export const SEED_RELEASE = "SEED";

export type BaseWindowPlan =
  | { action: "tile"; closePredecessorAt: string }
  | { action: "update_in_place" };

/** Pure tiling decision for a CHANGED code, test-pinned. A successor window
 *  opens at the release effective date, closing its predecessor at eff − 1;
 *  when the effective date does not post-date the current window's start,
 *  the "change" is a correction of that window and is updated in place
 *  (tiling would mint an inverted or zero-length window). */
export function planBaseWindow(
  currentValidFrom: string | null,
  effectiveDate: string,
): BaseWindowPlan {
  return planWindow(currentValidFrom, effectiveDate);
}

/** Pure close-date decision for a REMOVED code, test-pinned: the last valid
 *  day is the day before the release takes effect, clamped to the window's
 *  own start so a same-day removal collapses to a one-day window instead of
 *  an inverted range. */
export function planBaseClose(
  currentValidFrom: string | null,
  effectiveDate: string,
): string {
  return planCloseDate(currentValidFrom, effectiveDate);
}

/** Pure change plan for one CHANGED code. SEED windows are corrected in
 *  place regardless of dates — the demo's approximate rate was never true,
 *  so there is no history to preserve (the certified rate is treated as
 *  having held for the whole window). Everything else follows the
 *  test-pinned tiling of planBaseWindow. */
export function planBaseChange(
  current: Pick<CurrentBaseWindow, "validFrom" | "release">,
  effectiveDate: string,
): BaseWindowPlan {
  if (current.release === SEED_RELEASE) return { action: "update_in_place" };
  return planBaseWindow(current.validFrom, effectiveDate);
}

export type ReauditSummary = {
  entries: number;
  cleared: number;
  created: number;
};

export type BaseApplyStats = {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  /** Null when no touched code is declared on any entry, in any org. */
  audit: ReauditSummary | null;
};

export type BaseApplyResult = BaseApplyStats & {
  release: string;
  effectiveDate: string;
  announcementId: string;
};

/** Apply a base-schedule diff inside a caller-provided transaction:
 *  unchanged rows get their release stamp refreshed in place, changed rows
 *  tile (or correct) their window, removed rows close, added/reappearing
 *  rows open a fresh window — then entries declaring a touched code are
 *  re-audited across EVERY org (the reference is global). Announcement
 *  bookkeeping belongs to the callers (stageBaseRelease opens it,
 *  applyBaseRelease resolves it). */
export async function applyBaseSchedule(
  db: DbClient,
  input: {
    release: string;
    effectiveDate: string;
    diff: BaseDiff;
  },
): Promise<BaseApplyStats> {
  const { release, effectiveDate, diff } = input;

  // Changed: tile or correct each current window.
  for (const { row, current } of diff.changed) {
    const plan = planBaseChange(current, effectiveDate);
    if (plan.action === "tile") {
      await db
        .update(schema.htsCodes)
        .set({ validTo: plan.closePredecessorAt, updatedAt: new Date() })
        .where(currentBaseWindowOf(row.codeDigits));
      await db
        .insert(schema.htsCodes)
        .values(baseWindowValues(row, release, effectiveDate));
    } else {
      await db
        .update(schema.htsCodes)
        .set({
          code: row.code,
          description: row.description,
          rateType: row.rateType,
          rate: row.rate === null ? null : row.rate.toFixed(6),
          col1General: row.col1General,
          col1Special: row.col1Special,
          col2Rate: row.col2Rate,
          unitOfQuantity: row.unitOfQuantity,
          indent: row.indent,
          parentDigits: row.parentDigits,
          rateInheritedFrom: row.rateInheritedFrom,
          release,
          updatedAt: new Date(),
        })
        .where(currentBaseWindowOf(row.codeDigits));
    }
  }

  // Removed: close the window (absence == removal).
  for (const gone of diff.removed) {
    await db
      .update(schema.htsCodes)
      .set({
        validTo: planBaseClose(gone.validFrom, effectiveDate),
        updatedAt: new Date(),
      })
      .where(currentBaseWindowOf(gone.codeDigits));
  }

  // Added (including codes reappearing beside closed history windows):
  // open a fresh window. Chunked — a first import inserts the whole
  // schedule.
  for (const batch of chunk(diff.added, 500)) {
    await db
      .insert(schema.htsCodes)
      .values(batch.map((row) => baseWindowValues(row, release, effectiveDate)));
  }

  // Refresh the release stamp on every remaining current base window in one
  // statement — after the writes above these are exactly the unchanged rows
  // plus this release's own inserts/corrections ("release" = the release
  // that last confirmed the row).
  await db
    .update(schema.htsCodes)
    .set({ release, updatedAt: new Date() })
    .where(
      and(
        isNull(schema.htsCodes.tradeMeasureId),
        isNull(schema.htsCodes.validTo),
      ),
    );

  const audit = await reauditTouchedEntriesAllOrgs(db, [
    ...diff.changed.map((c) => c.row.codeDigits),
    ...diff.removed.map((r) => r.codeDigits),
  ]);

  return {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged,
    audit,
  };
}

/** The approval-gated apply path for a staged base release. Validates the
 *  tariff_base_release review item is approved, re-derives the diff from
 *  the archived raw payload (the staged diffstat is display-only — deriving
 *  against live state inside the caller's transaction stays correct even if
 *  state moved between staging and approval), re-runs the sanity guard
 *  (opts.force = the reviewer's explicit override), applies, and resolves
 *  the announcement. */
export async function applyBaseRelease(
  db: DbClient,
  announcementId: string,
  opts: { effectiveDate?: string; force?: boolean } = {},
): Promise<BaseApplyResult> {
  const announcement = await db.query.tariffAnnouncements.findFirst({
    where: eq(schema.tariffAnnouncements.id, announcementId),
  });
  if (!announcement || !announcement.sourceRef.endsWith("-base")) {
    throw new ApplyValidationError("Not a base-schedule release announcement.");
  }
  if (announcement.status === "resolved") {
    throw new ApplyValidationError(
      "This base release was already applied and can no longer change.",
    );
  }

  const item = await db.query.reviewItems.findFirst({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_base_release"),
      eq(schema.reviewItems.subjectId, announcementId),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  if (!item || item.status !== "approved") {
    throw new ApplyValidationError(
      "Base releases apply only after the release's review item is approved.",
    );
  }
  if (!announcement.rawStorageKey) {
    throw new ApplyValidationError(
      "The archived release payload is missing — re-run the sync to re-stage.",
    );
  }

  const rawBytes = await getFileStore().get(announcement.rawStorageKey);
  const rows = parseBaseRows(JSON.parse(rawBytes.toString("utf8")));
  const current = await loadCurrentBaseWindows(db);
  const { prepared, diff } = runBaseEtl(rows, current);

  const sanity = checkBaseReleaseSanity(diff, prepared.length, current.length);
  if (!sanity.ok && !opts.force) {
    throw new ApplyValidationError(
      `Sanity guard blocked the apply: ${sanity.reasons.join(" ")} Approve with the override to force it.`,
    );
  }

  const proposal = item.proposal as BaseReleaseProposalDisplay;
  const effectiveDate = opts.effectiveDate ?? proposal.effectiveDate;
  const release = announcement.sourceRef.slice(0, -"-base".length);

  const stats = await applyBaseSchedule(db, { release, effectiveDate, diff });

  const summary = `${stats.added} added, ${stats.changed} changed, ${stats.removed} removed (${stats.unchanged} unchanged).`;
  await db
    .update(schema.tariffAnnouncements)
    .set({
      summary,
      publishedDate: effectiveDate,
      status: "resolved",
      updatedAt: new Date(),
    })
    .where(eq(schema.tariffAnnouncements.id, announcementId));

  return { release, effectiveDate, announcementId, ...stats };
}

/** Re-audit entries whose declared line digits match a changed/removed
 *  code, in EVERY org — base windows are global. Exact digits match
 *  suffices: rate inheritance means a subheading change surfaces on every
 *  inheriting 10-digit leaf as its own changed row, so declared leaf codes
 *  are always present in the touched set. */
async function reauditTouchedEntriesAllOrgs(
  db: DbClient,
  touchedDigits: string[],
): Promise<ReauditSummary | null> {
  if (touchedDigits.length === 0) return null;

  const orgs = await db.query.orgs.findMany({ columns: { id: true } });
  let entries = 0;
  let cleared = 0;
  let created = 0;

  for (const { id: orgId } of orgs) {
    const entryIds = new Set<string>();
    for (const digitsBatch of chunk(touchedDigits, 500)) {
      const rows = await db
        .selectDistinct({ entryId: schema.entryLineItems.entryId })
        .from(schema.entryLineItems)
        .where(
          and(
            eq(schema.entryLineItems.orgId, orgId),
            inArray(schema.entryLineItems.htsCodeDigits, digitsBatch),
          ),
        );
      for (const r of rows) entryIds.add(r.entryId);
    }
    if (entryIds.size === 0) continue;

    // Reference data reloaded AFTER the window writes so the re-audit sees
    // the new truth.
    const ref = await loadReferenceDataForOrg(db, orgId);
    for (const entryId of entryIds) {
      const before = await openAlertKeys(db, entryId);
      await auditEntry(db, orgId, entryId, ref);
      const after = await openAlertKeys(db, entryId);
      for (const key of before) if (!after.has(key)) cleared += 1;
      for (const key of after) if (!before.has(key)) created += 1;
    }
    entries += entryIds.size;
  }

  return entries === 0 ? null : { entries, cleared, created };
}

async function openAlertKeys(
  db: DbClient,
  entryId: string,
): Promise<Set<string>> {
  const rows = await db.query.auditAlerts.findMany({
    where: and(
      eq(schema.auditAlerts.entryId, entryId),
      eq(schema.auditAlerts.status, "open"),
    ),
    columns: { alertKey: true },
  });
  return new Set(rows.map((r) => r.alertKey));
}

/** The one current window per base code: digits + no measure + open. */
function currentBaseWindowOf(codeDigits: string) {
  return and(
    eq(schema.htsCodes.codeDigits, codeDigits),
    isNull(schema.htsCodes.tradeMeasureId),
    isNull(schema.htsCodes.validTo),
  );
}

function baseWindowValues(
  row: PreparedBaseRow,
  release: string,
  effectiveDate: string,
): typeof schema.htsCodes.$inferInsert {
  return {
    code: row.code,
    codeDigits: row.codeDigits,
    description: row.description,
    chapter: row.chapter,
    rateType: row.rateType,
    rate: row.rate === null ? null : row.rate.toFixed(6),
    col1General: row.col1General,
    col1Special: row.col1Special,
    col2Rate: row.col2Rate,
    unitOfQuantity: row.unitOfQuantity,
    indent: row.indent,
    parentDigits: row.parentDigits,
    rateInheritedFrom: row.rateInheritedFrom,
    release,
    validFrom: effectiveDate,
    validTo: null,
    tradeMeasureId: null,
    exemption: false,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
