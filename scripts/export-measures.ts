// One-off CSV export of every trade measure with its Chapter 99 rate lines
// and covered HTS prefixes. One row per (measure, Ch99 line); measures with
// no lines still get a row. Writes to OUT_CSV (default ./measures-export.csv).
//
// Run: npx tsx scripts/export-measures.ts
//   - against a PGlite copy:  PGLITE_DATA_DIR=/path/to/copy npx tsx scripts/export-measures.ts
//   - against Postgres/Neon:  DATABASE_URL=postgres://... npx tsx scripts/export-measures.ts
// tsx runs this as CJS — no top-level await; everything lives in main().

import { writeFileSync } from "node:fs";

import { asc, isNotNull } from "drizzle-orm";

// Relative imports on purpose: tsx does not resolve the `@/` alias here.
import { db, schema } from "../src/lib/db";

const HEADERS = [
  "measure_id",
  "name",
  "authority",
  "scope",
  "countries",
  "countries_excluded",
  "effective_date",
  "end_date",
  "sailed_on_or_after",
  "sailed_on_or_before",
  "in_lieu_of_base_duty",
  "predecessor_id",
  "ch99_code",
  "rate_type",
  "rate",
  "col1_general",
  "exemption",
  "covered_hts_prefixes",
  "notes",
];

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = Array.isArray(value) ? value.join(";") : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function main() {
  const measures = await db
    .select()
    .from(schema.tradeMeasures)
    .orderBy(
      asc(schema.tradeMeasures.authority),
      asc(schema.tradeMeasures.name),
      asc(schema.tradeMeasures.effectiveDate),
    );
  const lines = await db
    .select()
    .from(schema.htsCodes)
    .where(isNotNull(schema.htsCodes.tradeMeasureId))
    .orderBy(asc(schema.htsCodes.codeDigits));
  const prefixes = await db.select().from(schema.tradeMeasureHts);

  const linesByMeasure = new Map<string, typeof lines>();
  for (const line of lines) {
    const key = line.tradeMeasureId!;
    (linesByMeasure.get(key) ?? linesByMeasure.set(key, []).get(key)!).push(line);
  }
  const prefixesByMeasure = new Map<string, string[]>();
  for (const p of prefixes) {
    (
      prefixesByMeasure.get(p.tradeMeasureId) ??
      prefixesByMeasure.set(p.tradeMeasureId, []).get(p.tradeMeasureId)!
    ).push(p.htsPrefix);
  }

  const rows: string[] = [HEADERS.join(",")];
  for (const m of measures) {
    const coveredPrefixes = (prefixesByMeasure.get(m.id) ?? []).sort();
    const measureCells = [
      m.id,
      m.name,
      m.authority,
      m.scope,
      m.countries,
      m.countriesExcluded,
      m.effectiveDate,
      m.endDate,
      m.sailedOnOrAfter,
      m.sailedOnOrBefore,
      m.inLieuOfBaseDuty,
      m.predecessorId,
    ];
    const measureLines = linesByMeasure.get(m.id) ?? [null];
    for (const line of measureLines) {
      rows.push(
        [
          ...measureCells,
          line?.code,
          line?.rateType,
          line?.rate,
          line?.col1General,
          line?.exemption,
          coveredPrefixes,
          m.notes,
        ]
          .map(csvField)
          .join(","),
      );
    }
  }

  const out = process.env.OUT_CSV ?? "./measures-export.csv";
  writeFileSync(out, rows.join("\n") + "\n");
  console.log(
    `${measures.length} measures, ${lines.length} Ch99 lines -> ${rows.length - 1} rows -> ${out}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
