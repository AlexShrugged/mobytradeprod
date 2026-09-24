// Stamp the Section 232 automobile and auto-parts measures' product scope
// from the schedule's own lists. The 2026-08-17 restage hand-curated every
// product-scoped heading's prefixes (the sync stages `prefixes: []` — it
// reads Chapter 99 heading rows, never the U.S. Notes that enumerate a
// heading's products), and the auto measures got whole headings: "8708"
// for parts, "8703 8704" for vehicles. U.S. note 33 to subchapter III
// enumerates the provisions instead: (b) vehicles (17 provisions),
// (g) parts (130), and the United Kingdom's own lists, (i) vehicles (12)
// and (j) parts (267 statistical reporting numbers). 8708.99.81 —
// MotoRad's "other parts" basket — is NOT in (g) (only 8708.99.53/.55/
// .58/.68 are): 55 false "Missing Section 232 Autos" alerts on 38 entries,
// $2.9M of phantom expected duty, plus 5 false "Unexpected" alerts on lock
// lines (8301.20.00, which IS in (g)) the whole-heading prefix never
// reached (found 2026-09-24).
//
// Source: USITC Harmonized Tariff Schedule, current release (2026 Basic
// Revision 19), Chapter 99 Subchapter III U.S. note 33 — the same publisher
// the daily sync integrates with (hts.usitc.gov/reststop) — read from the
// release's Chapter 99 document on 2026-09-24:
//   https://hts.usitc.gov/reststop/file?release=currentRelease&filename=Chapter%2099
// The lists below are the provisions as printed there (a 4-digit entry
// such as "8471" or "8707" is a whole heading as published; the note's
// (p) inclusions heading 9903.94.07 is importer-certified and excludes
// (g) articles, so it widens nothing). Re-derive from the current release
// before trusting them for a new proclamation.
//
// Rewrites trade_measure_hts for every hts_list-scoped auto measure whose
// list differs, stamps the source on the measure's notes, re-audits every
// entry the old or new prefixes reach (idempotent by alert_key), and with
// --queue-analyses queues a tariff_apply re-run for the analyzed entries
// among them (the AI findings that corroborated the phantom expectation
// persist until re-analyzed).
//
//   DATABASE_URL=... npx tsx scripts/apply-section232-autos-scope.ts                         # dry run
//   DATABASE_URL=... npx tsx scripts/apply-section232-autos-scope.ts --apply
//   DATABASE_URL=... npx tsx scripts/apply-section232-autos-scope.ts --apply --queue-analyses
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, inArray } from "drizzle-orm";

import { queueReanalysesForEntries } from "../src/lib/analysis/service";
import {
  findEntriesForHtsPrefixes,
  sweepAuditsForEntries,
} from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";

const SOURCE = "USITC HTS 2026 Rev. 19, Chapter 99 subchapter III U.S. note 33";
const READ_ON = "2026-09-24";

const provisions = (text: string) => text.trim().split(/\s+/);

// (b): passenger vehicles and light trucks — headings 9903.94.01–.04,
// .40/.41 (Japan), .50/.51 (EU), .60/.61 (Korea).
const NOTE_33_B = provisions(`
8703.22.01 8703.23.01 8703.24.01 8703.31.01 8703.32.01 8703.33.01
8703.40.00 8703.50.00 8703.60.00 8703.70.00 8703.80.00 8703.90.01
8704.21.01 8704.31.01 8704.41.00 8704.51.00 8704.60.00
`);

// (g): parts of passenger vehicles and light trucks — headings 9903.94.05,
// .42/.43 (Japan), .52/.53 (EU), .62/.63 (Korea), .66/.67 (Taiwan).
const NOTE_33_G = provisions(`
4009.12.0020 4009.22.0020 4009.32.0020 4009.42.0020 4011.10.10 4011.10.50
4011.20.10 4012.19.40 4012.19.80 4012.20.60 4013.10.0010 4013.10.0020
4016.99.6010 7007.21.51 7009.10.00 7320.10 7320.20.10 8301.20.00
8302.10.30 8302.30 8407.31.00 8407.32 8407.33 8407.34
8408.20.20 8409.91.1040 8409.99.1040 8413.30.10 8413.30.90 8413.91.10
8413.91.9010 8414.30.8030 8414.59.30 8414.59.6540 8414.80.05 8415.20.00
8421.23.00 8421.32.00 8425.49.00 8426.91.00 8431.10.0090 8471
8482.10.10 8482.10.5044 8482.10.5048 8482.20.0020 8482.20.0030 8482.20.0040
8482.20.0061 8482.20.0070 8482.20.0081 8482.40.00 8482.50.00 8483.10.1030
8483.10.30 8501.32 8501.33 8501.34 8501.40 8501.51
8501.52 8507.10 8507.60 8507.90.40 8507.90.80 8511.10.0000
8511.20.00 8511.30.0040 8511.30.0080 8511.40.00 8511.50.00 8511.80.20
8511.80.60 8511.90.6020 8511.90.6040 8512.20.20 8512.20.40 8512.30.00
8512.40.20 8512.40.40 8512.90.20 8512.90.60 8512.90.70 8519.81.20
8525.60.1010 8527.21 8527.29 8536.41.0005 8537.10 8537.20
8539.10.0010 8539.10.0050 8544.30.00 8706.00.03 8706.00.05 8706.00.15
8706.00.25 8707 8707.10.0020 8707.10.0040 8707.90.5020 8707.90.5040
8707.90.5060 8707.90.5080 8708.10.30 8708.10.60 8708.21.00 8708.22
8708.29 8708.30 8708.40.11 8708.40.70 8708.40.75 8708.50
8708.70 8708.80 8708.91 8708.93.60 8708.93.75 8708.94
8708.95 8708.99.53 8708.99.55 8708.99.58 8708.99.68 8716.90.50
9015.10 9029.10 9029.20.4080 9401.20.00
`);

// (i): United Kingdom passenger vehicles under the quota heading 9903.94.31.
const NOTE_33_I = provisions(`
8703.22.01 8703.23.01 8703.24.01 8703.31.01 8703.32.01 8703.33.01
8703.40.00 8703.50.00 8703.60.00 8703.70.00 8703.80.00 8703.90.01
`);

// (j): United Kingdom parts under heading 9903.94.32 — statistical
// reporting numbers of the HTSUS Annotated.
const NOTE_33_J = provisions(`
4009.12.0020 4009.22.0020 4009.32.0020 4009.42.0020 4011.10.1010 4011.10.1020
4011.10.1030 4011.10.1040 4011.10.1050 4011.10.1060 4011.10.1070 4011.10.5000
4011.20.1005 4011.20.1015 4012.19.8000 4012.20.6000 4013.10.0010 4013.10.0020
4016.99.6010 7007.21.5100 7009.10.0000 7320.10.3000 7320.10.6015 7320.10.6060
7320.10.9015 7320.10.9060 7320.20.1000 8301.20.0030 8301.20.0060 8302.10.3000
8302.30.3010 8302.30.3060 8302.30.6000 8407.31.0080 8407.32.2040 8407.32.2080
8407.32.9040 8407.32.9080 8407.33.3040 8407.33.3080 8407.33.6040 8407.33.6080
8407.33.9040 8407.33.9080 8407.34.0530 8407.34.0560 8407.34.0590 8407.34.1400
8407.34.1800 8407.34.2500 8407.34.3530 8407.34.3590 8407.34.4400 8407.34.4800
8407.34.5500 8408.20.2000 8409.91.1040 8409.99.1040 8413.30.1000 8413.30.9030
8413.30.9060 8413.30.9090 8413.91.1000 8413.91.9010 8414.30.8030 8414.59.3000
8414.59.6540 8414.80.0500 8415.20.0000 8421.23.0000 8421.32.0000 8425.49.0000
8426.91.0000 8431.10.0090 8482.10.1040 8482.10.1080 8482.10.5044 8482.10.5048
8482.20.0020 8482.20.0030 8482.20.0040 8482.20.0061 8482.20.0070 8482.20.0081
8482.40.0000 8482.50.0000 8483.10.1030 8483.10.3010 8483.10.3050 8501.32.2000
8501.32.4500 8501.32.5520 8501.32.5540 8501.32.6100 8501.33.2040 8501.33.2080
8501.33.3000 8501.33.4040 8501.33.4060 8501.33.6100 8501.34.3000 8501.34.6100
8501.40.2020 8501.40.2040 8501.40.4020 8501.40.4040 8501.40.5020 8501.40.5040
8501.40.6020 8501.40.6040 8501.51.2020 8501.51.2040 8501.51.4020 8501.51.4040
8501.51.5020 8501.51.5040 8501.51.6020 8501.51.6040 8501.52.4000 8501.52.8020
8501.52.8040 8507.10.0030 8507.10.0060 8507.10.0090 8507.60.0010 8507.60.0020
8507.90.4000 8507.90.8000 8511.10.0000 8511.20.0000 8511.30.0040 8511.30.0080
8511.40.0000 8511.50.0000 8511.80.2000 8511.80.6000 8511.90.6020 8511.90.6040
8512.20.2040 8512.20.2080 8512.20.4040 8512.20.4080 8512.30.0020 8512.30.0030
8512.30.0040 8512.40.2000 8512.40.4000 8512.90.2000 8512.90.6000 8512.90.7000
8519.81.2000 8525.60.1010 8527.21.1500 8527.21.2525 8527.21.4080 8527.29.4000
8527.29.8000 8539.10.0010 8539.10.0050 8544.30.0000 8706.00.0520 8706.00.1520
8706.00.1540 8706.00.2500 8707.10.0020 8707.10.0040 8707.90.5060 8707.90.5080
8708.10.3020 8708.10.3030 8708.10.3040 8708.10.3050 8708.10.6010 8708.10.6050
8708.21.0000 8708.22.0000 8708.29.1500 8708.29.2120 8708.29.2130 8708.29.2140
8708.29.2500 8708.29.5110 8708.29.5125 8708.29.5160 8708.30.1010 8708.30.1090
8708.30.5020 8708.30.5030 8708.30.5040 8708.30.5090 8708.40.1110 8708.40.1150
8708.40.7000 8708.40.7570 8708.40.7580 8708.50.1110 8708.50.1150 8708.50.3110
8708.50.3150 8708.50.5110 8708.50.5150 8708.50.6100 8708.50.6500 8708.50.7000
8708.50.7500 8708.50.7900 8708.50.8100 8708.50.8500 8708.50.8900 8708.50.9110
8708.50.9150 8708.50.9300 8708.50.9500 8708.50.9900 8708.70.0500 8708.70.1500
8708.70.2500 8708.70.3500 8708.70.4530 8708.70.4546 8708.70.4548 8708.70.4560
8708.70.6030 8708.70.6045 8708.70.6060 8708.80.0300 8708.80.0500 8708.80.1300
8708.80.1600 8708.80.5100 8708.80.5500 8708.80.6000 8708.80.6510 8708.80.6590
8708.91.1000 8708.91.5000 8708.91.6000 8708.91.6500 8708.91.7510 8708.91.7550
8708.93.6000 8708.93.7500 8708.94.1000 8708.94.5000 8708.94.6000 8708.94.6500
8708.94.7000 8708.94.7510 8708.94.7550 8708.95.0500 8708.95.1000 8708.95.2000
8708.99.5300 8708.99.5500 8708.99.5800 8708.99.6805 8708.99.6810 8708.99.6890
8716.90.5010 8716.90.5048 8716.90.5060 9015.10.4000 9015.10.8000 9029.10.4000
9029.10.8000 9029.20.4080 9401.20.0000
`);

type ScopeList = { subdivision: string; provisions: string[] };
const B: ScopeList = { subdivision: "(b)", provisions: NOTE_33_B };
const G: ScopeList = { subdivision: "(g)", provisions: NOTE_33_G };
const I: ScopeList = { subdivision: "(i)", provisions: NOTE_33_I };
const J: ScopeList = { subdivision: "(j)", provisions: NOTE_33_J };

// Heading → the subdivision that enumerates its products. (b) names the
// worldwide, Japan, EU and Korea vehicle headings; (g) the worldwide, Japan,
// EU, Korea and Taiwan parts headings; the UK deal headings carry their own
// lists. Only hts_list-scoped liability measures are touched — the $0
// exemption rows of each family stay all_products by construction.
const SCOPE_BY_HEADING: Record<string, ScopeList> = {
  "9903.94.01": B,
  "9903.94.41": B,
  "9903.94.51": B,
  "9903.94.61": B,
  "9903.94.31": I,
  "9903.94.05": G,
  "9903.94.43": G,
  "9903.94.53": G,
  "9903.94.63": G,
  "9903.94.67": G,
  "9903.94.32": J,
};

const digitsOf = (provision: string) => provision.replace(/\D/g, "");
const sortedUnique = (xs: string[]) => [...new Set(xs)].sort();
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

type Plan = {
  measureId: string;
  code: string;
  name: string;
  countries: string[] | null;
  subdivision: string;
  notes: string | null;
  from: string[];
  to: string[];
};

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const queueAnalyses = args.includes("--queue-analyses");

  // Sanity on the lists themselves before anything reads them.
  for (const [label, list] of [
    ["(b)", NOTE_33_B],
    ["(g)", NOTE_33_G],
    ["(i)", NOTE_33_I],
    ["(j)", NOTE_33_J],
  ] as const) {
    const bad = list.filter((p) => !/^\d{4}(\.\d{2}){0,2}(\.\d{4})?$/.test(p) || digitsOf(p).length > 10);
    if (bad.length > 0) throw new Error(`note 33${label}: malformed provisions ${bad.join(" ")}`);
    if (new Set(list).size !== list.length) throw new Error(`note 33${label}: duplicate provisions`);
  }
  console.log(
    `Source: ${SOURCE}, read ${READ_ON} — (b) ${NOTE_33_B.length}, (g) ${NOTE_33_G.length}, (i) ${NOTE_33_I.length}, (j) ${NOTE_33_J.length} provisions`,
  );

  const measures = await db.query.tradeMeasures.findMany({
    where: eq(schema.tradeMeasures.authority, "section_232_autos"),
  });
  const measureIds = measures.map((m) => m.id);
  const [liabilityRows, prefixRows] = await Promise.all([
    db.query.htsCodes.findMany({
      where: and(
        inArray(schema.htsCodes.tradeMeasureId, measureIds),
        eq(schema.htsCodes.exemption, false),
      ),
    }),
    db.query.tradeMeasureHts.findMany({
      where: inArray(schema.tradeMeasureHts.tradeMeasureId, measureIds),
    }),
  ]);
  const codeByMeasure = new Map<string, string>();
  for (const h of liabilityRows) codeByMeasure.set(h.tradeMeasureId!, h.code);
  const prefixesByMeasure = new Map<string, string[]>();
  for (const p of prefixRows) {
    const list = prefixesByMeasure.get(p.tradeMeasureId) ?? [];
    list.push(p.htsPrefix);
    prefixesByMeasure.set(p.tradeMeasureId, list);
  }

  const plans: Plan[] = [];
  for (const m of [...measures].sort((a, b) => a.name.localeCompare(b.name))) {
    const code = codeByMeasure.get(m.id);
    const from = sortedUnique(prefixesByMeasure.get(m.id) ?? []);
    const where = `${m.name}${m.countries ? ` [${m.countries.join(",")}]` : ""}`;
    if (!code) {
      console.log(`  skip  ${where}: exemption family row (no liability heading)`);
      continue;
    }
    const scope = SCOPE_BY_HEADING[code];
    if (m.scope !== "hts_list") {
      console.log(
        `  skip  ${where}: scope ${m.scope}${scope ? ` — NOTE: note 33${scope.subdivision} enumerates this heading's products; an all_products liability would over-reach` : ""}`,
      );
      continue;
    }
    if (!scope) {
      console.log(`  skip  ${where}: no note-33 list mapped for ${code} (prefixes ${from.join(" ") || "none"})`);
      continue;
    }
    const to = sortedUnique(scope.provisions.map(digitsOf));
    if (sameList(from, to)) {
      console.log(`  ok    ${where}: already note 33${scope.subdivision} (${to.length} prefixes)`);
      continue;
    }
    plans.push({
      measureId: m.id,
      code,
      name: m.name,
      countries: m.countries,
      subdivision: scope.subdivision,
      notes: m.notes,
      from,
      to,
    });
    console.log(
      `  plan  ${where}: ${from.length === 0 ? "none" : from.join(" ")} → note 33${scope.subdivision}, ${to.length} prefixes`,
    );
  }

  if (plans.length === 0) {
    console.log("\nNothing to change.");
    return;
  }

  // Blast radius: entries with a line under any old or new prefix (every
  // org — reference data is global). The re-audit is idempotent, so the
  // union over-includes harmlessly.
  const reachPrefixes = sortedUnique(plans.flatMap((p) => [...p.from, ...p.to]));
  const targets = await findEntriesForHtsPrefixes(db, reachPrefixes);
  const orgs = await db.query.orgs.findMany({ columns: { id: true, name: true } });
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const perOrg = new Map<string, number>();
  for (const t of targets) perOrg.set(t.orgId, (perOrg.get(t.orgId) ?? 0) + 1);
  console.log(
    `\n${targets.length} entr${targets.length === 1 ? "y" : "ies"} reached by the old or new prefixes: ${[...perOrg].map(([id, n]) => `${orgName.get(id) ?? id} ${n}`).join(", ") || "none"}`,
  );

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Pass --apply to rewrite the prefixes and re-audit.");
    return;
  }

  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx
        .delete(schema.tradeMeasureHts)
        .where(eq(schema.tradeMeasureHts.tradeMeasureId, p.measureId));
      await tx
        .insert(schema.tradeMeasureHts)
        .values(p.to.map((htsPrefix) => ({ tradeMeasureId: p.measureId, htsPrefix })));
      const stamp = `Scope: ${SOURCE} ${p.subdivision}, ${p.to.length} provisions as published (read ${READ_ON}; replaced ${p.from.join(" ") || "none"}).`;
      await tx
        .update(schema.tradeMeasures)
        .set({
          notes: p.notes ? `${p.notes.trim()} ${stamp}` : stamp,
          updatedAt: new Date(),
        })
        .where(eq(schema.tradeMeasures.id, p.measureId));
    }
  });
  console.log(`\nAPPLIED: ${plans.length} measure(s) rescoped.`);

  if (targets.length === 0) return;
  const audit = await sweepAuditsForEntries(db, targets);
  console.log(
    `re-audited ${audit.entries}: ${audit.cleared} alert(s) cleared, ${audit.created} opened`,
  );
  if (queueAnalyses) {
    const queued = await queueReanalysesForEntries(
      db,
      targets.map((t) => t.entryId),
    );
    console.log(`${queued} re-analysis run(s) queued (tariff_apply) — the sweep cron drains them`);
  } else {
    console.log(
      "AI findings on these entries persist until re-analyzed — re-run with --queue-analyses.",
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
