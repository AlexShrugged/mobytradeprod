// Sync orchestrators: fetch USITC / Federal Register, stage Chapter 99
// revisions into the generic review queue, and stage base-schedule releases
// for release-level approval. This module is the ONLY writer of
// measure_revisions and tariff review items, and the only writer of
// tariff_announcements' open/staged states (apply.ts flips revisions to
// applied; base-apply.ts owns base windows and resolves the "<release>-base"
// announcement at approval). Reference tables are NEVER touched here.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray } from "drizzle-orm";

import * as schema from "../db/schema";
import type { DbClient } from "../duty/reference";
import { getFileStore } from "../storage";
import { checkBaseReleaseSanity } from "./base-guard";
import { SEED_RELEASE } from "./base-apply";
import { runBaseEtl } from "./base-etl";
import { diffRelease } from "./differ";
import { getMeasureExtractor } from "./extractor";
import { mergeExtraction } from "./extractor/merge";
import { fetchRecentNotices } from "./federal-register";
import { partitionRevisions, type RevisionGroupKey } from "./grouping";
import {
  loadCurrentBaseWindows,
  loadOpenRevisions,
  loadTariffSyncState,
} from "./state";
import type {
  BaseDiff,
  BaseReleaseProposalDisplay,
  BaseReleaseSanity,
  FrNotice,
  GroupProposalDisplay,
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
  /** Which extractor proposed dates/countries on staged create_measure
   *  revisions (null when nothing was extracted). */
  extractor: "stub" | "claude" | null;
};

/** Diff → extract → stage. Takes the NON-transactional handle: state reads
 *  and the extractor (network IO when Claude-backed) run outside any
 *  transaction; only the staging writes get one. The cron is the only
 *  staging writer, so the read-outside-tx race is theoretical — and the
 *  (announcement, code) unique index is the correctness backstop. */
export async function runUsitcSync(
  db: DbClient,
  fetched: {
    release: HtsRelease;
    rows: Awaited<ReturnType<typeof fetchChapter99>>["rows"];
    rawStorageKey: string | null;
  },
  today: string,
  deps: { notices?: FrNotice[] } = {},
): Promise<UsitcSyncResult> {
  const state = await loadTariffSyncState(db);
  const open = await loadOpenRevisions(db);
  // Wholesale adoption: untracked release codes stage too, grouped by
  // (authority, prefix) family below so the queue gets a handful of family
  // cards instead of hundreds of atomized ones.
  const { revisions, superseded, untrackedCodes } = diffRelease(
    fetched.rows,
    state,
    open,
    { stageNewCodes: true },
  );

  if (revisions.length === 0 && superseded.length === 0) {
    return {
      releaseId: fetched.release.id,
      announcementId: null,
      staged: 0,
      superseded: 0,
      unchanged: true,
      extractor: null,
    };
  }

  // Extraction proposes dates/countries/rates for NEW measures (the differ
  // already fills what it can deterministically; tracked-measure changes
  // carry live context). Already-staged revisions never reach here — the
  // differ's hash dedupe skipped them — so unchanged re-fetches cost zero
  // extractor calls and operator edits are never clobbered.
  const toStage = [...revisions];
  let extractorUsed: "stub" | "claude" | null = null;
  const createIdx = toStage
    .map((r, i) => (r.changeType === "create_measure" ? i : -1))
    .filter((i) => i >= 0);
  if (createIdx.length > 0) {
    const extractor = getMeasureExtractor();
    const extractions = await extractor.extract(
      createIdx.map((i) => ({
        ch99Code: toStage[i].ch99Code,
        authority: toStage[i].authority,
        evidence: toStage[i].evidence,
        relatedNotices: deps.notices ?? [],
      })),
    );
    for (const [k, i] of createIdx.entries()) {
      const ex = extractions[k];
      if (!ex) continue;
      toStage[i] = mergeExtraction(toStage[i], ex);
      extractorUsed = ex.extractor;
    }
  }

  return db.transaction(async (tx) => {
    // One announcement per (source, release id); a re-fetch of the same
    // release attaches any newly diffed revisions to the existing row.
    const [announcement] = await tx
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
          `${toStage.length} Chapter 99 change(s) staged for review.` +
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
      // Individual revisions have a queue item to flip; grouped members
      // supersede via the timestamp alone (their group item stays pending
      // for the members that survive).
      const itemIds = superseded
        .map((s) => s.reviewItemId)
        .filter((id): id is string => id !== null);
      if (itemIds.length > 0) {
        await tx
          .update(schema.reviewItems)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(inArray(schema.reviewItems.id, itemIds));
      }
      await tx
        .update(schema.measureRevisions)
        .set({ supersededAt: new Date(), updatedAt: new Date() })
        .where(
          inArray(
            schema.measureRevisions.id,
            superseded.map((s) => s.revisionId),
          ),
        );
    }

    const { grouped, individual } = partitionRevisions(toStage);

    let staged = 0;
    for (const rev of individual) {
      staged += await stageRevision(tx, announcement, rev);
    }
    for (const { key, revisions: members } of grouped.values()) {
      staged += await stageRevisionGroup(tx, announcement, key, members);
    }

    return {
      releaseId: fetched.release.id,
      announcementId: announcement.id,
      staged,
      superseded: superseded.length,
      unchanged: false,
      extractor: extractorUsed,
    };
  });
}

/** Stage one (authority, prefix) family: upsert the group row, insert its
 *  member revisions (no per-revision queue items), and keep exactly one
 *  pending tariff_measure_group item whose proposal carries the display
 *  payload. Re-syncs refresh the payload in place — live member counts are
 *  derived at read time, so a stale card shrinks instead of lying.
 *  Exported for targeted-adoption scripts; the sync is the other caller. */
export async function stageRevisionGroup(
  db: DbClient,
  announcement: schema.TariffAnnouncement,
  key: RevisionGroupKey,
  members: ProposedRevision[],
): Promise<number> {
  const [group] = await db
    .insert(schema.measureRevisionGroups)
    .values({
      announcementId: announcement.id,
      authority: key.authority,
      ch99Prefix: key.ch99Prefix,
      title: key.title,
    })
    .onConflictDoUpdate({
      target: [
        schema.measureRevisionGroups.announcementId,
        schema.measureRevisionGroups.authority,
        schema.measureRevisionGroups.ch99Prefix,
      ],
      set: { title: key.title, updatedAt: new Date() },
    })
    .returning();

  let staged = 0;
  for (const batch of chunkArray(members, 100)) {
    const inserted = await db
      .insert(schema.measureRevisions)
      .values(
        batch.map((rev) => ({
          announcementId: announcement.id,
          changeType: rev.changeType,
          ch99Code: rev.ch99Code,
          authority: rev.authority,
          targetMeasureId: rev.targetMeasureId,
          proposed: rev.proposed,
          evidence: rev.evidence,
          liveSnapshot: rev.liveSnapshot,
          contentHash: rev.contentHash,
          groupId: group.id,
        })),
      )
      .onConflictDoNothing() // (announcement, code) already staged
      .returning({ id: schema.measureRevisions.id });
    staged += inserted.length;
  }

  const proposal: GroupProposalDisplay = {
    authority: key.authority,
    ch99Prefix: key.ch99Prefix,
    title: key.title,
    codeCount: members.length,
    sampleCodes: members.slice(0, 10).map((rev) => ({
      ch99Code: rev.ch99Code,
      name: rev.proposed.name,
      rate: rev.proposed.rate,
      exemption: rev.proposed.exemption,
    })),
    source: announcement.source,
    sourceRef: announcement.sourceRef,
    announcementTitle: announcement.title,
  };

  const existing = await db.query.reviewItems.findFirst({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_group"),
      eq(schema.reviewItems.subjectId, group.id),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  if (existing) {
    await db
      .update(schema.reviewItems)
      .set({ proposal, updatedAt: new Date() })
      .where(eq(schema.reviewItems.id, existing.id));
  } else {
    // Global queue item (org_id null), like every tariff item.
    await db.insert(schema.reviewItems).values({
      itemType: "tariff_measure_group",
      subjectId: group.id,
      proposal,
    });
  }

  return staged;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Stage ONE revision + its global review item. Exported for the legacy
 *  bootstrap import script; the sync itself is the only other caller. */
export async function stageRevision(
  db: DbClient,
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
  // Global queue item (org_id null): tariff reference changes have no org —
  // one super-admin approval takes effect for every tenant.
  await db.insert(schema.reviewItems).values({
    itemType: "tariff_measure_revision",
    subjectId: revision.id,
    payloadId: revision.id,
    proposal,
  });
  return 1;
}

export type BaseStageResult = {
  releaseId: string;
  announcementId: string | null;
  reviewItemId: string | null;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  sanity: BaseReleaseSanity;
  /** False when the diff was empty — nothing to review, announcement
   *  recorded as resolved. */
  staged: boolean;
};

const SAMPLE_CAP = 20;

/** Stage a base-schedule release as ONE reviewable unit: an open
 *  "<release>-base" announcement plus a global tariff_base_release review
 *  item whose proposal carries the diffstat, sanity verdict, and spot-check
 *  samples. The full diff is deliberately NOT persisted — derived data is
 *  never stored; applyBaseRelease re-derives it from the archived raw
 *  payload at approval time. */
export async function stageBaseRelease(
  db: DbClient,
  input: {
    release: HtsRelease;
    effectiveDate: string;
    diff: BaseDiff;
    sanity: BaseReleaseSanity;
    /** Required (not best-effort): approval re-derives from this payload. */
    rawStorageKey: string;
  },
): Promise<BaseStageResult> {
  const { release, effectiveDate, diff, sanity } = input;
  const sourceRef = `${release.id}-base`;
  const emptyDiff =
    diff.added.length === 0 &&
    diff.changed.length === 0 &&
    diff.removed.length === 0;

  // A newer release supersedes any pending base release (USITC's exportList
  // always serves the current schedule, so at most one base release is ever
  // actionable); with an empty diff the live state already matches the
  // latest release and EVERY pending base item is moot.
  const pendingItems = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_base_release"),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  let existingItem: (typeof pendingItems)[number] | null = null;
  for (const item of pendingItems) {
    const announcement = await db.query.tariffAnnouncements.findFirst({
      where: eq(schema.tariffAnnouncements.id, item.subjectId),
    });
    if (!emptyDiff && announcement?.sourceRef === sourceRef) {
      existingItem = item; // same release re-fetched: refresh its proposal
      continue;
    }
    await db
      .update(schema.reviewItems)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(eq(schema.reviewItems.id, item.id));
    if (announcement && announcement.status === "open") {
      await db
        .update(schema.tariffAnnouncements)
        .set({
          status: "resolved",
          summary: emptyDiff
            ? `Superseded — live schedule matches ${release.name}.`
            : `Superseded by ${release.name}.`,
          updatedAt: new Date(),
        })
        .where(eq(schema.tariffAnnouncements.id, announcement.id));
    }
  }

  const diffstat = `${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed (${diff.unchanged} unchanged)`;
  const summary = emptyDiff
    ? `${diffstat}.`
    : `${diffstat} — staged for release-level approval.` +
      (sanity.ok ? "" : ` SANITY GUARD TRIPPED: ${sanity.reasons.join(" ")}`);

  const [announcement] = await db
    .insert(schema.tariffAnnouncements)
    .values({
      source: "usitc_hts",
      sourceRef,
      title: `USITC HTS base schedule ${release.name}`,
      url: "https://hts.usitc.gov/",
      publishedDate: effectiveDate,
      fetchedAt: new Date(),
      rawStorageKey: input.rawStorageKey,
      summary,
      status: emptyDiff ? "resolved" : "open",
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
        status: emptyDiff ? "resolved" : "open",
        updatedAt: new Date(),
      },
    })
    .returning();

  if (emptyDiff) {
    return {
      releaseId: release.id,
      announcementId: announcement.id,
      reviewItemId: null,
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: diff.unchanged,
      sanity,
      staged: false,
    };
  }

  const proposal: BaseReleaseProposalDisplay = {
    release: release.id,
    releaseName: release.name,
    effectiveDate,
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged,
    sanity,
    seedCorrections: diff.changed.filter(
      (c) => c.current.release === SEED_RELEASE,
    ).length,
    sampleAdded: diff.added.slice(0, SAMPLE_CAP).map((r) => ({
      code: r.code,
      description: r.description,
      rate: r.rate,
    })),
    sampleChanged: diff.changed.slice(0, SAMPLE_CAP).map(({ row, current }) => ({
      code: row.code,
      description: row.description,
      rateBefore: current.rate,
      rateAfter: row.rate,
    })),
    sampleRemoved: diff.removed.slice(0, SAMPLE_CAP).map((r) => ({
      code: r.code,
      description: r.description,
    })),
  };

  // Same release re-staged (state moved since the pending item was cut):
  // refresh the proposal in place rather than fighting the one-pending-per-
  // subject unique index. Global item — org_id stays null.
  let reviewItemId: string;
  if (existingItem) {
    await db
      .update(schema.reviewItems)
      .set({ proposal, updatedAt: new Date() })
      .where(eq(schema.reviewItems.id, existingItem.id));
    reviewItemId = existingItem.id;
  } else {
    const [item] = await db
      .insert(schema.reviewItems)
      .values({
        itemType: "tariff_base_release",
        subjectId: announcement.id,
        proposal,
      })
      .returning();
    reviewItemId = item.id;
  }

  return {
    releaseId: release.id,
    announcementId: announcement.id,
    reviewItemId,
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged,
    sanity,
    staged: true,
  };
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
  base: BaseStageResult | { error: string };
};

/** The full sync entry point the route and cron call: network IO outside
 *  the transactions, staging inside them. The three parts are deliberately
 *  independent — a base-schedule failure must not abort the Chapter 99 diff
 *  (or vice-versa), so each collects its own result or error. Nothing here
 *  touches reference tables; every change waits in the review queue. */
export async function runTariffSync(
  db: DbClient,
  today: string,
  opts: {
    /** Overrides the staged base-window effective date (default: the
     *  release's start date from releaseList, falling back to today). The
     *  reviewer can still override at approval. */
    baseEffectiveDate?: string;
  } = {},
): Promise<TariffSyncSummary> {
  const store = getFileStore();

  // Federal Register first: its notices feed the Chapter 99 extraction
  // (effective dates live in FR prose, never in the structured feed). Its
  // failure degrades extraction context, never the diff itself.
  let federalRegister: FrSyncResult | { error: string };
  let notices: FrNotice[] = [];
  try {
    const fetchedFr = await fetchRecentNotices({ daysBack: 30, today });
    notices = fetchedFr.notices;
    let rawStorageKey: string | null = null;
    try {
      const put = await store.put(
        `tariff-fr-${today}.json`,
        Buffer.from(JSON.stringify(fetchedFr.raw)),
      );
      rawStorageKey = put.storageKey;
    } catch {
      // Raw archival is best-effort; staging does not need it.
    }
    federalRegister = await db.transaction((tx) =>
      runFederalRegisterSync(tx, notices, rawStorageKey),
    );
  } catch (err) {
    federalRegister = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

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
      // Best-effort, as above.
    }
    // runUsitcSync owns its own staging transaction — extraction (network
    // IO when Claude-backed) must run outside it.
    usitc = await runUsitcSync(db, { release, rows, rawStorageKey }, today, {
      notices,
    });
  } catch (err) {
    usitc = { error: err instanceof Error ? err.message : String(err) };
  }

  let base: BaseStageResult | { error: string };
  try {
    // Fetched independently of the Chapter 99 path (including its own
    // releaseList call) so one path's failure never starves the other.
    const release = await latestRelease();
    const { rows, raw } = await fetchBaseSchedule();
    // Archival is MANDATORY on this path (unlike Ch99/FR): approval
    // re-derives the diff from this payload, so a failed put means the
    // release cannot be staged at all. Separate archive from the Chapter 99
    // pull — the two exports must never overwrite each other.
    const put = await store.put(
      `tariff-base-${release.id}.json`,
      Buffer.from(JSON.stringify(raw)),
    );
    const effectiveDate =
      opts.baseEffectiveDate ?? release.effectiveDate ?? today;
    base = await db.transaction(async (tx) => {
      // Current windows read inside the same transaction the staging writes
      // in, so the diffstat can never race a concurrent apply.
      const current = await loadCurrentBaseWindows(tx);
      const { prepared, diff } = runBaseEtl(rows, current);
      const sanity = checkBaseReleaseSanity(diff, prepared.length, current.length);
      return stageBaseRelease(tx, {
        release,
        effectiveDate,
        diff,
        sanity,
        rawStorageKey: put.storageKey,
      });
    });
  } catch (err) {
    base = { error: err instanceof Error ? err.message : String(err) };
  }

  return { usitc, federalRegister, base };
}
