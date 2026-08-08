// One-time bootstrap: convert the legacy moby platform's hand-curated
// Chapter 99 data into individually-approvable staged proposals in the
// tariff review queue. READ-ONLY against the moby checkout; writes only
// staging tables (announcement + measure_revisions + review items) — the
// super admin approves each measure in /admin/tariffs before anything
// touches reference data.
//
//   npx tsx scripts/import-legacy-tariff.ts            # dry run (default)
//   npx tsx scripts/import-legacy-tariff.ts --apply    # stage for review
//   npx tsx scripts/... --apply --reset                # drop this import's
//     PENDING staging (announcement + revisions + queue items — never
//     applied measures) and re-stage fresh, e.g. after classification fixes
//   MOBY_DIR=/path/to/moby npx tsx scripts/... 	     # non-sibling checkout
//
// Re-run safe: announcement upserts, (announcement, code) unique +
// content-hash dedupe skip unchanged rows, applied codes fall into
// skipped-live. Stop the dev server first (PGlite is single-process).
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { and, eq, inArray } from "drizzle-orm";

import { db, schema } from "../src/lib/db";
import {
  buildLegacyRevisions,
  buildReciprocalNote,
  mergePrefixMaps,
  parseLegacyMeasures,
  parseMappingCsv,
} from "../src/lib/tariff-sync/legacy-import";
import { loadOpenRevisions, loadTariffSyncState } from "../src/lib/tariff-sync/state";
import { stageRevision } from "../src/lib/tariff-sync/sync";

const ANNOUNCEMENT_SOURCE_REF = "legacy-moby-import";

/** ch99 column / base column per legacy CSV (they disagree on order). */
const MAPPING_FILES: { path: string; ch99Column: string; baseColumn: string }[] = [
  { path: "data/lookups/section_301_mappings.csv", ch99Column: "Section_301_HTS", baseColumn: "General_HTS" },
  { path: "data/lookups/section_232_copper_mappings.csv", ch99Column: "Copper_232_HTS", baseColumn: "General_HTS" },
  { path: "data/lookups/section_232_metals_2026_mappings.csv", ch99Column: "Chapter99_HTS", baseColumn: "General_HTS" },
  { path: "data/lookups/timber_furniture_mappings.csv", ch99Column: "Chapter99_HTS", baseColumn: "General_HTS" },
  { path: "data/lookups/section_338_annex_mappings.csv", ch99Column: "Chapter99_HTS", baseColumn: "General_HTS" },
  { path: "data/lookups/section_338_alcohol_mappings.csv", ch99Column: "Chapter99_HTS", baseColumn: "General_HTS" },
  { path: "data/lookups/section_338_dairy_mappings.csv", ch99Column: "Chapter99_HTS", baseColumn: "General_HTS" },
  { path: "data/lookups/section_338_motor_vehicles_mappings.csv", ch99Column: "Chapter99_HTS", baseColumn: "General_HTS" },
];

/** Drop this import's UNAPPLIED staging so it can be re-staged fresh.
 *  Applied revisions (appliedAt set) are live reference lineage and are
 *  never touched — if any exist, the announcement stays and re-staging
 *  attaches to it. */
async function resetPendingImport(): Promise<void> {
  const announcement = await db.query.tariffAnnouncements.findFirst({
    where: and(
      eq(schema.tariffAnnouncements.source, "manual"),
      eq(schema.tariffAnnouncements.sourceRef, ANNOUNCEMENT_SOURCE_REF),
    ),
  });
  if (!announcement) {
    console.log("(--reset: no prior import found)");
    return;
  }
  await db.transaction(async (tx) => {
    const revisions = await tx.query.measureRevisions.findMany({
      where: eq(schema.measureRevisions.announcementId, announcement.id),
      columns: { id: true, appliedAt: true },
    });
    const applied = revisions.filter((r) => r.appliedAt !== null);
    const pendingIds = revisions
      .filter((r) => r.appliedAt === null)
      .map((r) => r.id);

    if (pendingIds.length > 0) {
      await tx
        .delete(schema.reviewItems)
        .where(inArray(schema.reviewItems.subjectId, pendingIds));
      await tx
        .delete(schema.measureRevisions)
        .where(inArray(schema.measureRevisions.id, pendingIds));
    }
    if (applied.length === 0) {
      await tx
        .delete(schema.tariffAnnouncements)
        .where(eq(schema.tariffAnnouncements.id, announcement.id));
    }
    console.log(
      `(--reset: removed ${pendingIds.length} pending proposal(s); ${applied.length} applied revision(s) kept)`,
    );
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const reset = process.argv.includes("--reset");
  const mobyDir = resolve(process.cwd(), process.env.MOBY_DIR ?? "../moby");

  if (reset && apply) await resetPendingImport();

  const measuresPath = join(mobyDir, "data/trade_measures/chapter_99_measures.json");
  if (!existsSync(measuresPath)) {
    console.error(
      `Not found: ${measuresPath}\nSet MOBY_DIR to the legacy moby checkout (default ../moby).`,
    );
    process.exit(1);
  }

  const { rows: curated, excluded } = parseLegacyMeasures(
    JSON.parse(readFileSync(measuresPath, "utf8")),
  );

  const prefixMaps = [];
  for (const file of MAPPING_FILES) {
    const path = join(mobyDir, file.path);
    if (!existsSync(path)) {
      console.warn(`(missing mapping file, skipping) ${file.path}`);
      continue;
    }
    const map = parseMappingCsv(readFileSync(path, "utf8"), file);
    prefixMaps.push(map);
    console.log(
      `${file.path}: ${map.size} Ch99 code(s), ${[...map.values()].reduce((s, v) => s + v.length, 0)} prefix rows`,
    );
  }
  const prefixesByDigits = mergePrefixMaps(prefixMaps);

  const reciprocalPath = join(mobyDir, "data/reciprocal_tariffs.csv");
  const reciprocalNote = existsSync(reciprocalPath)
    ? buildReciprocalNote(readFileSync(reciprocalPath, "utf8"))
    : null;

  const state = await loadTariffSyncState(db);
  const open = await loadOpenRevisions(db);
  const result = buildLegacyRevisions(curated, prefixesByDigits, state, open, {
    reciprocalNote: reciprocalNote ?? undefined,
  });

  console.log(`\nLegacy curated measures: ${curated.length}`);
  console.log(`  to stage:        ${result.revisions.length}`);
  console.log(`  skipped (live):  ${result.skippedLive.length}  ${result.skippedLive.join(" ")}`);
  console.log(`  skipped (open):  ${result.skippedPending.length}  ${result.skippedPending.join(" ")}`);
  for (const ex of excluded) {
    console.log(`  excluded:        ${ex.code} — ${ex.reason}`);
  }

  console.log("\n  type            code         rate    window                    prefixes  name");
  for (const rev of result.revisions) {
    const p = rev.proposed;
    console.log(
      `  ${rev.changeType.padEnd(14)}  ${rev.ch99Code}  ${p.exemption ? "exempt" : p.rate === null ? "?" : (p.rate * 100).toFixed(1) + "%"}`.padEnd(46) +
        `${p.effectiveDate ?? "?"} → ${p.endDate ?? "open"}`.padEnd(26) +
        `${String(p.prefixes.length).padStart(5)}     ${p.name}`,
    );
  }

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to stage for review.");
    return;
  }
  if (result.revisions.length === 0) {
    console.log("\nNothing to stage.");
    return;
  }

  const staged = await db.transaction(async (tx) => {
    const [announcement] = await tx
      .insert(schema.tariffAnnouncements)
      .values({
        source: "manual",
        sourceRef: ANNOUNCEMENT_SOURCE_REF,
        title: "Legacy moby curated Chapter 99 import",
        url: null,
        publishedDate: new Date().toISOString().slice(0, 10),
        fetchedAt: new Date(),
        rawStorageKey: null,
        summary: `${result.revisions.length} curated measure(s) staged for review from the legacy platform.`,
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

    let count = 0;
    for (const rev of result.revisions) {
      count += await stageRevision(tx, announcement, rev);
    }
    return count;
  });

  console.log(
    `\nStaged ${staged} proposal(s) under announcement "${ANNOUNCEMENT_SOURCE_REF}".` +
      "\nReview and approve them at /admin/tariffs — nothing touches reference data until then.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
