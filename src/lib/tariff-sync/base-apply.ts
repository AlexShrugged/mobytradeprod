// The SOLE writer of base-schedule hts_codes windows. Base refreshes apply
// directly — ~30k objective MFN rows are not review material — but every
// refresh records an announcement row (source "usitc_hts", sourceRef
// "<release>-base", status resolved) so the diffstat shows up next to the
// review-gated Chapter 99 announcements.
//
// Window tiling (same rationale as Chapter 99 apply.ts): when a release
// changes a code's rate or description, the current window closes at
// effectiveDate − 1 and a successor opens at effectiveDate (valid_to null),
// so historical entries keep auditing against the base rates of their day.
// Codes absent from the release get their window closed (absence ==
// removal; USITC has no change feed); a code reappearing later simply opens
// a new window next to its closed history.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray, isNull } from "drizzle-orm";

import { auditEntry } from "../audit/auditor";
import * as schema from "../db/schema";
import { loadReferenceData, type DbClient } from "../duty/reference";
import { dayBefore } from "./apply";
import type { BaseDiff, PreparedBaseRow } from "./types";

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
  if (currentValidFrom === null || effectiveDate > currentValidFrom) {
    return { action: "tile", closePredecessorAt: dayBefore(effectiveDate) };
  }
  return { action: "update_in_place" };
}

/** Pure close-date decision for a REMOVED code, test-pinned: the last valid
 *  day is the day before the release takes effect, clamped to the window's
 *  own start so a same-day removal collapses to a one-day window instead of
 *  an inverted range. */
export function planBaseClose(
  currentValidFrom: string | null,
  effectiveDate: string,
): string {
  const closeAt = dayBefore(effectiveDate);
  if (currentValidFrom !== null && closeAt < currentValidFrom) {
    return currentValidFrom;
  }
  return closeAt;
}

export type ReauditSummary = {
  entries: number;
  cleared: number;
  created: number;
};

export type BaseApplyResult = {
  release: string;
  effectiveDate: string;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  announcementId: string;
  /** Null when no code the org's entries declare was touched. */
  audit: ReauditSummary | null;
};

/** Apply a base-schedule diff inside a caller-provided transaction:
 *  unchanged rows get their release stamp refreshed in place, changed rows
 *  tile (or correct) their window, removed rows close, added/reappearing
 *  rows open a fresh window — then entries declaring a touched code are
 *  re-audited (the targeted equivalent of apply.ts's post-apply sweep). */
export async function applyBaseSchedule(
  db: DbClient,
  orgId: string,
  input: {
    release: string;
    /** Release start date from releaseList, overridable by callers. */
    effectiveDate: string;
    diff: BaseDiff;
    rawStorageKey: string | null;
  },
): Promise<BaseApplyResult> {
  const { release, effectiveDate, diff } = input;

  // Changed: tile or correct each current window.
  for (const { row, current } of diff.changed) {
    const plan = planBaseWindow(current.validFrom, effectiveDate);
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

  // The diffstat announcement. sourceRef "<release>-base" keeps it distinct
  // from the same release's Chapter 99 announcement; a re-run of the same
  // release upserts rather than duplicating. Status resolved — base
  // refreshes apply directly, there is nothing to review.
  const summary = `${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed (${diff.unchanged} unchanged).`;
  const [announcement] = await db
    .insert(schema.tariffAnnouncements)
    .values({
      source: "usitc_hts",
      sourceRef: `${release}-base`,
      title: `USITC HTS base schedule ${release}`,
      url: "https://hts.usitc.gov/",
      publishedDate: effectiveDate,
      fetchedAt: new Date(),
      rawStorageKey: input.rawStorageKey,
      summary,
      status: "resolved",
    })
    .onConflictDoUpdate({
      target: [
        schema.tariffAnnouncements.source,
        schema.tariffAnnouncements.sourceRef,
      ],
      set: {
        fetchedAt: new Date(),
        summary,
        publishedDate: effectiveDate,
        rawStorageKey: input.rawStorageKey,
        status: "resolved",
        updatedAt: new Date(),
      },
    })
    .returning();

  const audit = await reauditTouchedEntries(db, orgId, [
    ...diff.changed.map((c) => c.row.codeDigits),
    ...diff.removed.map((r) => r.codeDigits),
  ]);

  return {
    release,
    effectiveDate,
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged,
    announcementId: announcement.id,
    audit,
  };
}

/** Re-audit entries whose declared line digits match a changed/removed
 *  code. Exact digits match suffices: rate inheritance means a subheading
 *  change surfaces on every inheriting 10-digit leaf as its own changed
 *  row, so declared leaf codes are always present in the touched set. */
async function reauditTouchedEntries(
  db: DbClient,
  orgId: string,
  touchedDigits: string[],
): Promise<ReauditSummary | null> {
  if (touchedDigits.length === 0) return null;

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
  if (entryIds.size === 0) return null;

  // Reference data reloaded AFTER the window writes so the re-audit sees
  // the new truth.
  const ref = await loadReferenceData(db);
  let cleared = 0;
  let created = 0;
  for (const entryId of entryIds) {
    const before = await openAlertKeys(db, entryId);
    await auditEntry(db, orgId, entryId, ref);
    const after = await openAlertKeys(db, entryId);
    for (const key of before) if (!after.has(key)) cleared += 1;
    for (const key of after) if (!before.has(key)) created += 1;
  }
  return { entries: entryIds.size, cleared, created };
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
