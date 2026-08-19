// Stage the Section 122 ↔ 2026-metals cross-program carve-out on existing
// reference data (schema migration 0018 added the column; data staged before
// it carries null). Confirmed from ASC's own 7501s on 2026-08-19: the
// headings are paired bundles — 9903.82.02 at 50% files with 9903.03.06
// ("S122 EXCL, IRN/STL/ALUM, DERIV") at $0, while the 9903.82.01 no-content
// claim files with 9903.03.01 at 10%. Without the trigger, the engine
// stacks both programs and every missing-232 impact reads GROSS instead of
// NET (the displaced 10% never nets out).
//
// Sets carveout_trigger_program on the 9903.03.06 exemption rows (every
// family copy, both sail-tiled 122 windows) to the program of the 990382
// metals family, resolved FROM the data — the script refuses to guess:
// no 990382 liability rows, a null program, or mixed programs all abort.
// Then re-audits; the sweep is idempotent by alert_key, so re-running heals.
//
//   DATABASE_URL=... npx tsx scripts/apply-section122-carveout.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/apply-section122-carveout.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, inArray, like } from "drizzle-orm";

import { sweepAuditsAllOrgs } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import type { DbClient } from "../src/lib/duty/reference";

const EXEMPTION_FAMILY_PREFIX = "99030306"; // 9903.03.06 (+ stat suffixes)
const TRIGGER_FAMILY = "990382"; // the 2026 metals program's Ch99 family

class Rollback extends Error {}

async function run(tx: DbClient, log: (m: string) => void): Promise<number> {
  // Resolve the trigger program from the metals family's liability measures.
  const triggerRows = await tx.query.htsCodes.findMany({
    where: and(
      eq(schema.htsCodes.exemption, false),
      like(schema.htsCodes.codeDigits, `${TRIGGER_FAMILY}%`),
    ),
  });
  const measureIds = [
    ...new Set(triggerRows.map((h) => h.tradeMeasureId).filter(Boolean)),
  ] as string[];
  if (measureIds.length === 0) {
    throw new Error(`no liability rows under family ${TRIGGER_FAMILY} — nothing to trigger on`);
  }
  const measures = await tx.query.tradeMeasures.findMany({
    where: inArray(schema.tradeMeasures.id, measureIds),
  });
  const programs = [...new Set(measures.map((m) => m.program))];
  if (programs.length !== 1 || programs[0] === null) {
    throw new Error(
      `family ${TRIGGER_FAMILY} programs are not a single non-null value: ` +
        `${JSON.stringify(programs)} — assign the program first, then re-run`,
    );
  }
  const triggerProgram = programs[0];
  log(`trigger program (from ${measures.length} ${TRIGGER_FAMILY} measure(s)): ${triggerProgram}`);

  const exemptionRows = await tx.query.htsCodes.findMany({
    where: and(
      eq(schema.htsCodes.exemption, true),
      like(schema.htsCodes.codeDigits, `${EXEMPTION_FAMILY_PREFIX}%`),
    ),
  });
  if (exemptionRows.length === 0) {
    throw new Error(
      `no exemption rows under ${EXEMPTION_FAMILY_PREFIX} — is 9903.03.06 staged?`,
    );
  }
  const stale = exemptionRows.filter(
    (h) => h.carveoutTriggerProgram !== triggerProgram,
  );
  for (const h of exemptionRows) {
    log(
      `  ${h.code} (measure ${h.tradeMeasureId ?? "none"}): ` +
        (h.carveoutTriggerProgram === triggerProgram
          ? "already set"
          : `${h.carveoutTriggerProgram ?? "null"} -> ${triggerProgram}`),
    );
  }
  if (stale.length > 0) {
    await tx
      .update(schema.htsCodes)
      .set({ carveoutTriggerProgram: triggerProgram })
      .where(
        inArray(
          schema.htsCodes.id,
          stale.map((h) => h.id),
        ),
      );
  }
  log(`${stale.length} row(s) updated, ${exemptionRows.length - stale.length} already set`);
  return stale.length;
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
  console.log(
    "Note: previously analyzed entries keep their AI findings until re-analyzed — " +
      "re-run analysis on affected entries so finding dollars pick up the net swap.",
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
