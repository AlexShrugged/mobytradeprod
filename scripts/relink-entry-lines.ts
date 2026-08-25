// Heals entry lines sitting at part_id null even though a catalog part for
// their SKU exists: rows processed before the part arrived (the linker
// matches SKU→part at document-processing time, and only part-creation
// paths adopt retroactively), and rows orphaned by spelling — matching is
// now on the normalized SKU key (src/lib/parts/sku.ts, trim + casefold), so
// a line whose extracted casing differs from the catalog spelling links
// too. The Parts page counts a SKU Active only through this link. Each
// org's whole catalog is handed to adoptEntryLinesForParts, which finds the
// orphans itself and re-audits every touched entry in the same transaction
// (catalog HTS/COO comparisons apply only through the link), so expect new
// audit alerts where the catalog and the declared lines disagree.
//
//   DATABASE_URL=... npx tsx scripts/relink-entry-lines.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/relink-entry-lines.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { eq } from "drizzle-orm";

import { db, schema, type DbClient } from "../src/lib/db";
import { adoptEntryLinesForParts } from "../src/lib/processing/linker";

class Rollback extends Error {}

async function run(tx: DbClient, log: (m: string) => void): Promise<number> {
  const orgs = await tx.query.orgs.findMany({
    columns: { id: true, name: true },
  });
  let total = 0;

  for (const org of orgs) {
    const parts = await tx.query.parts.findMany({
      where: eq(schema.parts.orgId, org.id),
      columns: { id: true },
    });
    if (parts.length === 0) {
      log(`${org.name}: no catalog parts`);
      continue;
    }
    const { linkedLines, auditedEntries } = await adoptEntryLinesForParts(
      tx,
      org.id,
      parts.map((p) => p.id),
    );
    log(
      `${org.name}: ${parts.length} part(s) swept → ` +
        `${linkedLines} line(s) linked, ${auditedEntries} entry(ies) re-audited`,
    );
    total += linkedLines;
  }

  log(`total: ${total} entry line(s) linked`);
  return total;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const log = (m: string) => console.log(m);
  try {
    await db.transaction(async (tx) => {
      await run(tx, log);
      if (!apply) throw new Rollback();
    });
  } catch (err) {
    if (err instanceof Rollback) {
      console.log("\nDRY RUN — rolled back, nothing written.");
      return;
    }
    throw err;
  }
  console.log("\nAPPLIED.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
