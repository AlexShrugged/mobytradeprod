// Stage the ceiling shape on existing reference data. A Chapter 99 heading
// whose general column is a bare rate ("10%") is charged IN LIEU of the
// column-1 rate, and one whose article text says "with a column 1 rate less
// than 10 percent" reaches only lines below that gate — together, a
// CEILING: the line's total duty is max(column-1, ceiling). Additive
// surcharges read "The duty provided in the applicable subheading + 10%".
// The sync reads both idioms since 2026-09-17 (rate-parse.ts + differ.ts);
// measures staged before that were all stored flat — Taiwan's 9903.05.76
// made every Taiwanese line read as 15.6% and "underpaying" base duty.
//
// Derives the shape from the LIVE USITC text for every tracked liability
// heading (never from a hand list), flips only measures whose stored rate
// still matches the published one, then re-audits the entries the flipped
// measures reach (idempotent by alert_key). AI findings persist until
// re-analyzed: --queue-analyses queues a tariff_apply re-run for the
// previously analyzed entries among them — do that once the analyst prompt
// carrying the ceiling doctrine is deployed, so the re-run reads it.
//
//   DATABASE_URL=... npx tsx scripts/apply-ceiling-headings.ts                 # dry run
//   DATABASE_URL=... npx tsx scripts/apply-ceiling-headings.ts --apply
//   DATABASE_URL=... npx tsx scripts/apply-ceiling-headings.ts --apply --queue-analyses
//   DATABASE_URL=... npx tsx scripts/apply-ceiling-headings.ts --queue-analyses  # queue only: every in-lieu heading's reach
//   ... --code 9903.05.76                                                      # one heading
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, gte, inArray, isNotNull, like, lte, or } from "drizzle-orm";

import { queueReanalysesForEntries } from "../src/lib/analysis/service";
import { sweepAuditsForEntries, type SweepTarget } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import type { DbClient } from "../src/lib/duty/reference";
import {
  parseColumnOneThreshold,
  parseGeneralRate,
} from "../src/lib/tariff-sync/rate-parse";
import { fetchChapter99 } from "../src/lib/tariff-sync/usitc";

type Shape = { inLieu: boolean; gate: number | null };

type Plan = {
  measureId: string;
  code: string;
  name: string;
  countries: string[] | null;
  window: string;
  rate: number;
  general: string;
  from: Shape;
  to: Shape;
  gateSource: "clause" | "rate" | "none";
};

const pct = (r: number | null) =>
  r === null ? "—" : `${Math.round(r * 10000) / 100}%`;
const shapeLabel = (s: Shape) =>
  s.inLieu ? `in lieu${s.gate !== null ? ` <${pct(s.gate)}` : ""}` : "additive";
const sameShape = (a: Shape, b: Shape) =>
  a.inLieu === b.inLieu &&
  (a.gate === null) === (b.gate === null) &&
  (a.gate === null || b.gate === null || Math.abs(a.gate - b.gate) < 1e-9);

async function planAll(
  db: DbClient,
  onlyCode: string | null,
  log: (m: string) => void,
): Promise<Plan[]> {
  const { rows } = await fetchChapter99();
  const published = new Map(rows.map((r) => [r.digits, r]));
  log(`USITC: ${rows.length} Chapter 99 lines in the current release`);

  const [measures, liabilityRows] = await Promise.all([
    db.query.tradeMeasures.findMany(),
    db.query.htsCodes.findMany({
      where: and(
        isNotNull(schema.htsCodes.tradeMeasureId),
        eq(schema.htsCodes.exemption, false),
      ),
    }),
  ]);
  const measureById = new Map(measures.map((m) => [m.id, m]));

  const plans: Plan[] = [];
  let unchanged = 0;
  const skipped: string[] = [];
  for (const h of liabilityRows.sort((a, b) => a.code.localeCompare(b.code))) {
    if (onlyCode && h.code !== onlyCode) continue;
    const m = h.tradeMeasureId ? measureById.get(h.tradeMeasureId) : undefined;
    if (!m) continue;
    const row = published.get(h.codeDigits);
    if (!row) {
      skipped.push(`${h.code} (${m.name}): not in the current HTS release`);
      continue;
    }
    const parsed = parseGeneralRate(row.general);
    if (parsed.kind !== "additional" && parsed.kind !== "ad_valorem") {
      skipped.push(`${h.code} (${m.name}): rate text not an ad valorem idiom — "${row.general}"`);
      continue;
    }
    const stored = h.rate === null ? null : Number(h.rate);
    if (stored === null || Math.abs(stored - parsed.rate) > 1e-9) {
      // A historical window re-rated since, or a hand-set rate: the
      // published text no longer describes this row — leave it alone.
      skipped.push(
        `${h.code} (${m.name}, ${m.effectiveDate}..${m.endDate ?? "open"}): stored ${pct(stored)} ≠ published ${pct(parsed.rate)}`,
      );
      continue;
    }
    const inLieu = parsed.kind === "ad_valorem";
    const clause = inLieu ? parseColumnOneThreshold(row.description) : null;
    const to: Shape = {
      inLieu,
      gate: inLieu ? (clause ?? parsed.rate) : null,
    };
    const from: Shape = {
      inLieu: m.inLieuOfBaseDuty,
      gate: m.col1RateBelow === null ? null : Number(m.col1RateBelow),
    };
    if (sameShape(from, to)) {
      unchanged += 1;
      continue;
    }
    plans.push({
      measureId: m.id,
      code: h.code,
      name: m.name,
      countries: m.countries,
      window: `${m.effectiveDate}..${m.endDate ?? "open"}`,
      rate: parsed.rate,
      general: row.general,
      from,
      to,
      gateSource: !inLieu ? "none" : clause !== null ? "clause" : "rate",
    });
  }

  log(`\n${plans.length} measure(s) to flip, ${unchanged} already in shape, ${skipped.length} skipped`);
  for (const p of plans) {
    log(
      `  ${p.code}  ${p.name}  [${p.countries?.join(",") ?? "all"}]  ${p.window}  ${pct(p.rate)}` +
        `  ${shapeLabel(p.from)} -> ${shapeLabel(p.to)}` +
        (p.gateSource === "rate" ? "  (no column-1 clause in the text; ceiling assumed at the heading's rate)" : ""),
    );
  }
  if (skipped.length > 0) {
    log("\nskipped:");
    for (const s of skipped) log(`  ${s}`);
  }
  return plans;
}

/** Entries with a line the measure reaches: origin in scope, entry date in
 *  the window, and (all products or) a declared code under its prefixes —
 *  exactly the lines whose expected charges the flip changes. */
async function entriesReached(
  db: DbClient,
  measureId: string,
): Promise<SweepTarget[]> {
  const m = (await db.query.tradeMeasures.findFirst({
    where: eq(schema.tradeMeasures.id, measureId),
  }))!;
  const prefixes = (
    await db.query.tradeMeasureHts.findMany({
      where: eq(schema.tradeMeasureHts.tradeMeasureId, measureId),
    })
  ).map((p) => p.htsPrefix);
  if (m.scope !== "all_products" && prefixes.length === 0) return [];
  const rows = await db
    .selectDistinct({
      entryId: schema.entries.id,
      orgId: schema.entries.orgId,
    })
    .from(schema.entryLineItems)
    .innerJoin(schema.entries, eq(schema.entries.id, schema.entryLineItems.entryId))
    .where(
      and(
        m.countries
          ? inArray(schema.entryLineItems.countryOfOrigin, m.countries)
          : undefined,
        gte(schema.entries.entryDate, m.effectiveDate),
        m.endDate ? lte(schema.entries.entryDate, m.endDate) : undefined,
        m.scope === "all_products"
          ? undefined
          : or(
              ...prefixes.map((p) =>
                like(schema.entryLineItems.htsCodeDigits, `${p}%`),
              ),
            ),
      ),
    );
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const queueAnalyses = args.includes("--queue-analyses");
  const codeAt = args.indexOf("--code");
  const onlyCode = codeAt >= 0 ? (args[codeAt + 1] ?? null) : null;
  const log = (m: string) => console.log(m);

  if (queueAnalyses && !apply) {
    // Queue-only: the flip already happened (or nothing needed flipping)
    // and the analyst prompt carrying the doctrine is now deployed — queue
    // re-runs for the analyzed entries every in-lieu heading reaches.
    const inLieu = await db.query.tradeMeasures.findMany({
      where: eq(schema.tradeMeasures.inLieuOfBaseDuty, true),
    });
    const targets = new Map<string, SweepTarget>();
    for (const m of inLieu) {
      for (const t of await entriesReached(db, m.id)) targets.set(t.entryId, t);
    }
    const queued = await queueReanalysesForEntries(db, [...targets.keys()]);
    console.log(
      `${inLieu.length} in-lieu heading(s) reach ${targets.size} entr${targets.size === 1 ? "y" : "ies"}; ${queued} re-analysis run(s) queued (tariff_apply) — the sweep cron drains them`,
    );
    return;
  }

  const plans = await planAll(db, onlyCode, log);
  if (!apply) {
    console.log("\nDRY RUN — nothing written. Pass --apply to flip the measures and re-audit.");
    return;
  }
  if (plans.length === 0) {
    console.log("\nNothing to apply.");
    return;
  }

  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx
        .update(schema.tradeMeasures)
        .set({
          inLieuOfBaseDuty: p.to.inLieu,
          col1RateBelow: p.to.gate === null ? null : p.to.gate.toFixed(6),
          updatedAt: new Date(),
        })
        .where(eq(schema.tradeMeasures.id, p.measureId));
    }
  });
  console.log(`\nAPPLIED: ${plans.length} measure(s) flipped.`);

  // Re-audit exactly the entries whose expected charges moved.
  const targets = new Map<string, SweepTarget>();
  for (const p of plans) {
    for (const t of await entriesReached(db, p.measureId)) {
      targets.set(t.entryId, t);
    }
  }
  const reached = [...targets.values()];
  console.log(`${reached.length} entr${reached.length === 1 ? "y" : "ies"} reached by the flipped measures`);
  if (reached.length === 0) return;
  const audit = await sweepAuditsForEntries(db, reached);
  console.log(
    `re-audited ${audit.entries}: ${audit.cleared} alert(s) cleared, ${audit.created} opened`,
  );
  if (queueAnalyses) {
    const queued = await queueReanalysesForEntries(
      db,
      reached.map((t) => t.entryId),
    );
    console.log(`${queued} re-analysis run(s) queued (tariff_apply) — the sweep cron drains them`);
  } else {
    console.log(
      "AI findings on these entries persist until re-analyzed — re-run with --queue-analyses once the ceiling doctrine is deployed.",
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
