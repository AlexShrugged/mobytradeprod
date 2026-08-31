// End-cap the standalone 2025 Section 232 metal programs that the 2026
// consolidated metals program superseded. Proclamation 11021 (9903.82.01–.26,
// effective 2026-04-06) covers "aluminum, steel and copper articles and
// derivatives" in ONE program — brokers file the 50% under 9903.82.02 with
// the combined article text ("ALU, STL, COP, DER ALU, DER STL"; confirmed on
// ASC 7501s, e.g. 231-7385352-1). The legacy moby import (2026-08-17 parity
// pass) later applied the 2025 standalone copper program (9903.78.01,
// worldwide 50%) with NO end date; the standalone aluminum program
// (9903.85.67, eff 2025-03-12) has the same open window. Cross-program
// overlap is invisible to the same-program auto-supersede detector, and
// distinct programs stack by doctrine — so every post-April copper-scope
// line was expected to pay BOTH 50% charges, and the audit raised false
// "Missing Section 232 Copper" alerts on lines whose 9903.82.02 duty was
// correctly declared.
//
// The fix is windowing, not deletion: each superseded measure keeps its
// pre-consolidation window (copper 2025-08-01.., aluminum 2025-03-12..) and
// gets end-capped the day before the consolidated program takes effect, so
// historical entries still audit against the standalone headings of their
// day. Everything resolves FROM the data: the consolidated program and its
// effective date come from the 990382 liability family, and the script
// aborts on any target measure whose program or window isn't the expected
// shape. Scope not carried over by the consolidated program (e.g. the
// 8544.42/49 insulated-wire prefixes only the copper program lists) is
// disclosed — those codes simply stop expecting a 232 charge after the cap.
// Then re-audits; the sweep is idempotent by alert_key, so re-running heals.
//
//   DATABASE_URL=... npx tsx scripts/retire-superseded-232-programs.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/retire-superseded-232-programs.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, inArray, like, lte, sql } from "drizzle-orm";

import { sweepAuditsAllOrgs } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import type { DbClient } from "../src/lib/duty/reference";

const CONSOLIDATED_FAMILY = "990382"; // the 2026 metals program's Ch99 family
// Standalone 2025 families the consolidation absorbed. Steel has no
// standalone measure staged (known gap), so there is nothing to cap there.
const SUPERSEDED_FAMILIES = ["990378", "990385"];
const EXPECTED_PROGRAMS = new Set([
  "section-232-copper",
  "section-232-aluminum",
  null, // family exemption measures carry no program (lineage on the family)
]);

class Rollback extends Error {}

async function measuresForFamily(tx: DbClient, familyPrefix: string) {
  const rows = await tx.query.htsCodes.findMany({
    where: like(schema.htsCodes.codeDigits, `${familyPrefix}%`),
  });
  const ids = [
    ...new Set(rows.map((h) => h.tradeMeasureId).filter((v): v is string => v !== null)),
  ];
  return ids.length === 0
    ? []
    : await tx.query.tradeMeasures.findMany({
        where: inArray(schema.tradeMeasures.id, ids),
      });
}

async function run(tx: DbClient, log: (m: string) => void): Promise<number> {
  // ---- Resolve the consolidated program and the cap date from the data.
  const consolidated = await measuresForFamily(tx, CONSOLIDATED_FAMILY);
  const liability = consolidated.filter((m) =>
    m.program !== null,
  );
  const programs = [...new Set(liability.map((m) => m.program))];
  if (programs.length !== 1) {
    throw new Error(
      `family ${CONSOLIDATED_FAMILY} carries ${programs.length} distinct non-null program(s): ` +
        `${JSON.stringify(programs)} — need exactly one; assign programs first, then re-run`,
    );
  }
  const metalsProgram = programs[0]!;
  const metalsEffective = liability
    .map((m) => m.effectiveDate)
    .sort()[0];
  const cap = new Date(Date.parse(`${metalsEffective}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  log(`consolidated program: ${metalsProgram}, effective ${metalsEffective} — capping superseded windows at ${cap}`);

  const metalsPrefixes = (
    await tx
      .select({ p: schema.tradeMeasureHts.htsPrefix })
      .from(schema.tradeMeasureHts)
      .where(
        inArray(
          schema.tradeMeasureHts.tradeMeasureId,
          liability.map((m) => m.id),
        ),
      )
  ).map((r) => r.p);

  // ---- Collect and vet the superseded measures.
  let updated = 0;
  for (const family of SUPERSEDED_FAMILIES) {
    const targets = await measuresForFamily(tx, family);
    if (targets.length === 0) {
      log(`family ${family}: no measures staged — nothing to cap`);
      continue;
    }
    for (const m of targets) {
      if (!EXPECTED_PROGRAMS.has(m.program)) {
        throw new Error(
          `family ${family}: measure "${m.name}" carries unexpected program ` +
            `${JSON.stringify(m.program)} — refusing to cap; review by hand`,
        );
      }
      if (m.effectiveDate > cap) {
        throw new Error(
          `family ${family}: measure "${m.name}" is effective ${m.effectiveDate}, ` +
            `after the cap ${cap} — a post-consolidation window should not exist; review by hand`,
        );
      }
      if (m.endDate !== null && m.endDate <= cap) {
        log(`  ${m.name} (${m.effectiveDate}..${m.endDate}): already capped — skipped`);
        continue;
      }

      // Disclose scope the consolidated program does not carry forward.
      const prefixes = (
        await tx
          .select({ p: schema.tradeMeasureHts.htsPrefix })
          .from(schema.tradeMeasureHts)
          .where(eq(schema.tradeMeasureHts.tradeMeasureId, m.id))
      ).map((r) => r.p);
      const dropped = prefixes.filter(
        (p) => !metalsPrefixes.some((mp) => p.startsWith(mp) || mp.startsWith(p)),
      );
      if (dropped.length > 0) {
        log(
          `  NOTE: ${m.name} covers ${dropped.length} prefix(es) the consolidated ` +
            `program does not (${dropped.join(", ")}) — those codes stop expecting ` +
            `a 232 charge after ${cap}`,
        );
      }

      // Historical entries inside the kept window still audit against this
      // measure — count them so the change's footprint is explicit.
      const [kept] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(schema.entryLineItems)
        .innerJoin(
          schema.entries,
          eq(schema.entries.id, schema.entryLineItems.entryId),
        )
        .where(
          and(
            lte(schema.entries.entryDate, cap),
            sql`exists (select 1 from ${schema.tradeMeasureHts} t where t.trade_measure_id = ${m.id} and ${schema.entryLineItems.htsCodeDigits} like t.hts_prefix || '%')`,
          ),
        );

      await tx
        .update(schema.tradeMeasures)
        .set({
          endDate: cap,
          notes:
            `${m.notes ? `${m.notes} ` : ""}Superseded ${metalsEffective} by the ` +
            `consolidated Section 232 metals program (${metalsProgram}, ` +
            `Proclamation 11021 — aluminum, steel and copper articles and ` +
            `derivatives file under the 990382 family); window end-capped at ` +
            `${cap} by retire-superseded-232-programs.ts.`,
          updatedAt: new Date(),
        })
        .where(eq(schema.tradeMeasures.id, m.id));
      updated += 1;
      log(
        `  capped ${m.name} [${m.program ?? "no program"}]: ` +
          `${m.effectiveDate}..${m.endDate ?? "open"} -> ${m.effectiveDate}..${cap} ` +
          `(${kept.n} line(s) remain in the kept window)`,
      );
    }
  }
  return updated;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const log = (m: string) => console.log(m);
  let updated = 0;
  try {
    await db.transaction(async (tx) => {
      updated = await run(tx, log);
      if (!apply) throw new Rollback();
    });
  } catch (err) {
    if (err instanceof Rollback) {
      console.log(`\nDRY RUN — would cap ${updated} measure(s); rolled back, nothing written.`);
      return;
    }
    throw err;
  }
  const audit = await sweepAuditsAllOrgs(db);
  console.log(`\nAPPLIED — capped ${updated} measure(s). audit sweep:`, JSON.stringify(audit));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    if (err instanceof Error && err.cause) console.error("cause:", err.cause);
    process.exit(1);
  },
);
