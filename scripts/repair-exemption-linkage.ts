// One-time repair after the 2026-08-17 bulk approval: every exemption
// Chapter 99 row was applied as its own standalone measure, so no liability
// measure carried its family's exemption codes and audit Rule 1's "declared
// exclusion code satisfies its parent measure" never fired against the
// restaged reference (all 4 open missing_measure alerts on 2026-08-19 were
// this false positive — e.g. entry 231-7354576-2 flagged missing 9903.82.02
// on a line that declared the 9903.82.01 no-metal-content exception).
//
// Links every family's exemption codes under its liability measures via the
// same syncFamilyExemptionLinks the apply pipeline now runs, then re-audits —
// the sweep deletes open alerts that are no longer desired. The standalone
// exemption measures stay: they anchor the exemption windows isExemptionActive
// resolves against even when a family has no live liability yet.
//
//   DATABASE_URL=... npx tsx scripts/repair-exemption-linkage.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/repair-exemption-linkage.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { eq } from "drizzle-orm";

import { sweepAuditsAllOrgs } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import type { DbClient } from "../src/lib/duty/reference";
import { syncFamilyExemptionLinks } from "../src/lib/tariff-sync/apply";

class Rollback extends Error {}

async function run(tx: DbClient, log: (m: string) => void): Promise<number> {
  const exemptionRows = await tx.query.htsCodes.findMany({
    where: eq(schema.htsCodes.exemption, true),
  });
  const families = [
    ...new Set(exemptionRows.map((h) => h.codeDigits.slice(0, 6))),
  ].sort();
  log(`${exemptionRows.length} exemption row(s) across ${families.length} families`);

  let total = 0;
  for (const family of families) {
    const linked = await syncFamilyExemptionLinks(tx, family);
    if (linked > 0) log(`family ${family}: +${linked} link row(s)`);
    total += linked;
  }
  log(`total: ${total} exemption link row(s)`);
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
  const audit = await sweepAuditsAllOrgs(db);
  console.log("\nAPPLIED. audit sweep:", JSON.stringify(audit));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
