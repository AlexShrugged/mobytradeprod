// Sync orchestrators: fetch USITC / Federal Register, stage Chapter 99
// revisions into the generic review queue, and refresh the base schedule.
// This module is the ONLY writer of measure_revisions and
// tariff_measure_revision review items, and the only writer of Chapter 99 /
// Federal Register tariff_announcements (apply.ts flips revisions to
// applied; base-apply.ts owns base windows and records its own
// "<release>-base" diffstat announcement). Chapter 99 reference tables are
// NEVER touched here.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { inArray } from "drizzle-orm";

import * as schema from "../db/schema";
import type { DbClient } from "../duty/reference";
import { getFileStore } from "../storage";
import { applyBaseSchedule, type BaseApplyResult } from "./base-apply";
import { runBaseEtl } from "./base-etl";
import { diffRelease } from "./differ";
import { fetchRecentNotices } from "./federal-register";
import {
  loadCurrentBaseWindows,
  loadOpenRevisions,
  loadTariffSyncState,
} from "./state";
import type {
  FrNotice,
  ProposedRevision,
  RevisionProposalDisplay,
} from "./types";
import {
  fetchBaseSchedule,
  fetchChapter99,
  latestRelease,
  type HtsRelease,
} from "./usitc";

export type UsitcSyncResult = {
  releaseId: string;
  announcementId: string | null;
  staged: number;
  superseded: number;
  unchanged: boolean;
};

export async function runUsitcSync(
  db: DbClient,
  orgId: string,
  fetched: {
    release: HtsRelease;
    rows: Awaited<ReturnType<typeof fetchChapter99>>["rows"];
    rawStorageKey: string | null;
  },
  today: string,
): Promise<UsitcSyncResult> {
  const state = await loadTariffSyncState(db);
  const open = await loadOpenRevisions(db);
  const { revisions, superseded, untrackedCodes } = diffRelease(
    fetched.rows,
    state,
    open,
    { stageNewCodes: false },
  );

  if (revisions.length === 0 && superseded.length === 0) {
    return {
      releaseId: fetched.release.id,
      announcementId: null,
      staged: 0,
      superseded: 0,
      unchanged: true,
    };
  }

  // One announcement per (source, release id); a re-fetch of the same
  // release attaches any newly diffed revisions to the existing row.
  const [announcement] = await db
    .insert(schema.tariffAnnouncements)
    .values({
      source: "usitc_hts",
      sourceRef: fetched.release.id,
      title: `USITC HTS release ${fetched.release.name}`,
      url: "https://hts.usitc.gov/",
      publishedDate: today,
      fetchedAt: new Date(),
      rawStorageKey: fetched.rawStorageKey,
      summary:
        `${revisions.length} Chapter 99 change(s) staged for review.` +
        (untrackedCodes > 0
          ? ` ${untrackedCodes} release code(s) are not tracked in the reference subset and were not staged.`
          : ""),
      status: "open",
    })
    .onConflictDoUpdate({
      target: [
        schema.tariffAnnouncements.source,
        schema.tariffAnnouncements.sourceRef,
      ],
      set: { fetchedAt: new Date(), status: "open", updatedAt: new Date() },
    })
    .returning();

  if (superseded.length > 0) {
    await db
      .update(schema.reviewItems)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        inArray(
          schema.reviewItems.id,
          superseded.map((s) => s.reviewItemId),
        ),
      );
  }

  let staged = 0;
  for (const rev of revisions) {
    staged += await stageRevision(db, orgId, announcement, rev);
  }

  return {
    releaseId: fetched.release.id,
    announcementId: announcement.id,
    staged,
    superseded: superseded.length,
    unchanged: false,
  };
}

async function stageRevision(
  db: DbClient,
  orgId: string,
  announcement: schema.TariffAnnouncement,
  rev: ProposedRevision,
): Promise<number> {
  const [revision] = await db
    .insert(schema.measureRevisions)
    .values({
      announcementId: announcement.id,
      changeType: rev.changeType,
      ch99Code: rev.ch99Code,
      authority: rev.authority,
      targetMeasureId: rev.targetMeasureId,
      proposed: rev.proposed,
      evidence: rev.evidence,
      liveSnapshot: rev.liveSnapshot,
      contentHash: rev.contentHash,
    })
    .onConflictDoNothing() // (announcement, code) already staged
    .returning();
  if (!revision) return 0;

  const proposal: RevisionProposalDisplay = {
    changeType: rev.changeType,
    ch99Code: rev.ch99Code,
    authority: rev.authority,
    name: rev.proposed.name,
    rateBefore: rev.liveSnapshot?.rate ?? null,
    rateAfter: rev.proposed.rate,
    source: announcement.source,
    sourceRef: announcement.sourceRef,
    announcementTitle: announcement.title,
  };
  await db.insert(schema.reviewItems).values({
    orgId,
    itemType: "tariff_measure_revision",
    subjectId: revision.id,
    payloadId: revision.id,
    proposal,
  });
  return 1;
}

export type FrSyncResult = { fetched: number; created: number };

export async function runFederalRegisterSync(
  db: DbClient,
  notices: FrNotice[],
  rawStorageKey: string | null,
): Promise<FrSyncResult> {
  let created = 0;
  for (const n of notices) {
    const [row] = await db
      .insert(schema.tariffAnnouncements)
      .values({
        source: "federal_register",
        sourceRef: n.documentNumber,
        title: n.title,
        url: n.htmlUrl,
        publishedDate: n.publicationDate || null,
        fetchedAt: new Date(),
        rawStorageKey,
        summary: n.abstract,
        status: "open",
      })
      .onConflictDoNothing()
      .returning();
    if (row) created += 1;
  }
  return { fetched: notices.length, created };
}

export type TariffSyncSummary = {
  usitc: UsitcSyncResult | { error: string };
  federalRegister: FrSyncResult | { error: string };
  base: BaseApplyResult | { error: string };
};

/** The full sync entry point the route and cron call: network IO outside
 *  the transactions, staging/applying inside them. The three parts are
 *  deliberately independent — a base-schedule failure must not abort the
 *  Chapter 99 diff (or vice-versa), so each collects its own result or
 *  error. */
export async function runTariffSync(
  db: DbClient,
  orgId: string,
  today: string,
  opts: {
    /** Overrides the base-window effective date (default: the release's
     *  start date from releaseList, falling back to today). */
    baseEffectiveDate?: string;
  } = {},
): Promise<TariffSyncSummary> {
  const store = getFileStore();

  let usitc: UsitcSyncResult | { error: string };
  try {
    const release = await latestRelease();
    const { rows, raw } = await fetchChapter99();
    let rawStorageKey: string | null = null;
    try {
      // LocalFileStore.put generates its own key — store what it returns.
      const put = await store.put(
        `tariff-ch99-${release.id}.json`,
        Buffer.from(JSON.stringify(raw)),
      );
      rawStorageKey = put.storageKey;
    } catch {
      // Raw archival is best-effort; the diff itself does not need it.
    }
    usitc = await db.transaction((tx) =>
      runUsitcSync(tx, orgId, { release, rows, rawStorageKey }, today),
    );
  } catch (err) {
    usitc = { error: err instanceof Error ? err.message : String(err) };
  }

  let federalRegister: FrSyncResult | { error: string };
  try {
    const { notices, raw } = await fetchRecentNotices({ daysBack: 30, today });
    let rawStorageKey: string | null = null;
    try {
      const put = await store.put(
        `tariff-fr-${today}.json`,
        Buffer.from(JSON.stringify(raw)),
      );
      rawStorageKey = put.storageKey;
    } catch {
      // Best-effort, as above.
    }
    federalRegister = await db.transaction((tx) =>
      runFederalRegisterSync(tx, notices, rawStorageKey),
    );
  } catch (err) {
    federalRegister = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let base: BaseApplyResult | { error: string };
  try {
    // Fetched independently of the Chapter 99 path (including its own
    // releaseList call) so one path's failure never starves the other.
    const release = await latestRelease();
    const { rows, raw } = await fetchBaseSchedule();
    let rawStorageKey: string | null = null;
    try {
      // Separate archive from the Chapter 99 pull — the two exports must
      // never overwrite each other.
      const put = await store.put(
        `tariff-base-${release.id}.json`,
        Buffer.from(JSON.stringify(raw)),
      );
      rawStorageKey = put.storageKey;
    } catch {
      // Best-effort, as above.
    }
    const effectiveDate =
      opts.baseEffectiveDate ?? release.effectiveDate ?? today;
    base = await db.transaction(async (tx) => {
      // Current windows read inside the same transaction the apply writes
      // in, so the diff can never race a concurrent apply.
      const current = await loadCurrentBaseWindows(tx);
      const { diff } = runBaseEtl(rows, current);
      return applyBaseSchedule(tx, orgId, {
        release: release.id,
        effectiveDate,
        diff,
        rawStorageKey,
      });
    });
  } catch (err) {
    base = { error: err instanceof Error ? err.message : String(err) };
  }

  return { usitc, federalRegister, base };
}
