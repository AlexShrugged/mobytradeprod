// Targeted wholesale adoption: stage ONE Chapter 99 family (6-digit prefix)
// from an archived USITC export, without waiting for a live sync. Staging
// only — the normal content-hash supersession retires any open proposals
// for the same codes (e.g. lossy legacy-import blobs), and nothing touches
// reference tables until the super admin approves at /admin/tariffs.
//
//   npx tsx scripts/adopt-family.ts <family-prefix> <archived-export.json>
//   e.g. npx tsx scripts/adopt-family.ts 990302 \
//          .files/2eb51e9e-…-tariff-ch99-2026HTSRev14.json
//
// The release id is inferred from the archive filename ("…-<release>.json").
// Stop the dev server first (PGlite is single-process).
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { inArray } from "drizzle-orm";

import { db, schema } from "../src/lib/db";
import { diffRelease } from "../src/lib/tariff-sync/differ";
import { getMeasureExtractor } from "../src/lib/tariff-sync/extractor";
import { mergeExtraction } from "../src/lib/tariff-sync/extractor/merge";
import { partitionRevisions } from "../src/lib/tariff-sync/grouping";
import {
  loadOpenRevisions,
  loadTariffSyncState,
} from "../src/lib/tariff-sync/state";
import { stageRevision, stageRevisionGroup } from "../src/lib/tariff-sync/sync";
import { parseCh99Rows } from "../src/lib/tariff-sync/usitc";

async function main() {
  const [family, archivePath] = process.argv.slice(2);
  if (!/^\d{6}$/.test(family ?? "") || !archivePath) {
    console.error(
      "Usage: npx tsx scripts/adopt-family.ts <6-digit-prefix> <archived-ch99-export.json>",
    );
    process.exit(1);
  }
  const release =
    basename(archivePath).match(/-([^-]+)\.json$/)?.[1] ?? "archived";
  const rawStorageKey = basename(archivePath);

  const raw = JSON.parse(readFileSync(archivePath, "utf8"));
  const rows = parseCh99Rows(raw).filter((r) => r.digits.startsWith(family));
  if (rows.length === 0) {
    console.error(`No ${family}* rows in ${archivePath}`);
    process.exit(1);
  }
  console.log(`${release}: ${rows.length} rows in family ${family}`);

  // State filtered to the family so the differ can't propose end_measure
  // for live measures outside this row subset.
  const state = await loadTariffSyncState(db);
  const familyState = {
    byDigits: new Map(
      [...state.byDigits].filter(([digits]) => digits.startsWith(family)),
    ),
  };
  const open = await loadOpenRevisions(db);

  const { revisions, superseded } = diffRelease(rows, familyState, open, {
    stageNewCodes: true,
  });
  console.log(
    `diffed: ${revisions.length} revision(s); ${superseded.length} open proposal(s) superseded`,
  );

  // Extraction proposes dates/countries (Claude when ANTHROPIC_API_KEY is
  // set, deterministic stub otherwise — same seam as the sync).
  const extractor = getMeasureExtractor();
  const toStage = [...revisions];
  const createIdx = toStage
    .map((r, i) => (r.changeType === "create_measure" ? i : -1))
    .filter((i) => i >= 0);
  const extractions = await extractor.extract(
    createIdx.map((i) => ({
      ch99Code: toStage[i].ch99Code,
      authority: toStage[i].authority,
      evidence: toStage[i].evidence,
      relatedNotices: [],
    })),
  );
  for (const [k, i] of createIdx.entries()) {
    if (extractions[k]) toStage[i] = mergeExtraction(toStage[i], extractions[k]);
  }
  const withCountries = toStage.filter(
    (r) => (r.proposed.countries?.length ?? 0) > 0,
  ).length;
  console.log(`countries resolved on ${withCountries}/${toStage.length} proposal(s)`);

  const staged = await db.transaction(async (tx) => {
    const [announcement] = await tx
      .insert(schema.tariffAnnouncements)
      .values({
        source: "usitc_hts",
        sourceRef: release,
        title: `USITC HTS release ${release}`,
        url: "https://hts.usitc.gov/",
        publishedDate: new Date().toISOString().slice(0, 10),
        fetchedAt: new Date(),
        rawStorageKey,
        summary: `${toStage.length} Chapter 99 change(s) staged for review (${family} family, from the archived release).`,
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

    const itemIds = superseded
      .map((s) => s.reviewItemId)
      .filter((id): id is string => id !== null);
    if (itemIds.length > 0) {
      await tx
        .update(schema.reviewItems)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(inArray(schema.reviewItems.id, itemIds));
    }
    if (superseded.length > 0) {
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
    let count = 0;
    for (const rev of individual) {
      count += await stageRevision(tx, announcement, rev);
    }
    for (const { key, revisions: members } of grouped.values()) {
      count += await stageRevisionGroup(tx, announcement, key, members);
    }
    return count;
  });

  console.log(
    `staged ${staged} proposal(s) under announcement ${release}. Review at /admin/tariffs.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
