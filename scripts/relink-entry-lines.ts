// Heals entry lines processed before their catalog part existed: the linker
// matches SKU→part at document-processing time only, so an org that uploaded
// entry documents first and imported its parts catalog later has every line
// sitting at part_id null — and the Parts page counts every SKU Inactive
// ("Active" = referenced by at least one entry line). Part-creation paths now
// adopt orphaned lines as they go (adoptEntryLinesForParts); this script
// re-establishes the invariant for rows written before that existed. The
// adopter re-audits every touched entry in the same transaction (catalog
// HTS/COO comparisons apply only through the link), so expect new audit
// alerts where the catalog and the declared lines disagree.
//
//   DATABASE_URL=... npx tsx scripts/relink-entry-lines.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/relink-entry-lines.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db, schema, type DbClient } from "../src/lib/db";
import { adoptEntryLinesForParts } from "../src/lib/processing/linker";

class Rollback extends Error {}

async function run(tx: DbClient, log: (m: string) => void): Promise<number> {
  const orgs = await tx.query.orgs.findMany({
    columns: { id: true, name: true },
  });
  let total = 0;

  for (const org of orgs) {
    const orphans = await tx
      .selectDistinct({ sku: schema.entryLineItems.sku })
      .from(schema.entryLineItems)
      .where(
        and(
          eq(schema.entryLineItems.orgId, org.id),
          isNull(schema.entryLineItems.partId),
          isNotNull(schema.entryLineItems.sku),
        ),
      );
    const skus = orphans.flatMap((o) => (o.sku === null ? [] : [o.sku]));
    if (skus.length === 0) {
      log(`${org.name}: no orphaned entry lines`);
      continue;
    }

    const parts: { id: string }[] = [];
    for (let i = 0; i < skus.length; i += 5000) {
      parts.push(
        ...(await tx.query.parts.findMany({
          where: and(
            eq(schema.parts.orgId, org.id),
            inArray(schema.parts.sku, skus.slice(i, i + 5000)),
          ),
          columns: { id: true },
        })),
      );
    }
    const { linkedLines, auditedEntries } = await adoptEntryLinesForParts(
      tx,
      org.id,
      parts.map((p) => p.id),
    );
    log(
      `${org.name}: ${skus.length} orphaned SKU(s), ${parts.length} matching part(s) → ` +
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
