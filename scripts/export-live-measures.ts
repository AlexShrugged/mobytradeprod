// Read-only JSON export of live trade measures: window, program, countries,
// ch99 codes, prefix count. Input for planning a bulk queue approval.
//
// Run: DATABASE_URL=postgres://... npx tsx scripts/export-live-measures.ts
// tsx runs this as CJS — no top-level await; everything lives in main().

import { db, schema } from "../src/lib/db";

async function main() {
  const [measures, ch99, prefixes] = await Promise.all([
    db.query.tradeMeasures.findMany(),
    db.query.htsCodes.findMany(),
    db.query.tradeMeasureHts.findMany(),
  ]);
  const codesByMeasure = new Map<string, { code: string; exemption: boolean; rate: string | null }[]>();
  for (const h of ch99) {
    if (!h.tradeMeasureId) continue;
    const list = codesByMeasure.get(h.tradeMeasureId) ?? [];
    list.push({ code: h.code, exemption: h.exemption, rate: h.rate });
    codesByMeasure.set(h.tradeMeasureId, list);
  }
  const prefixCount = new Map<string, number>();
  for (const p of prefixes) {
    prefixCount.set(p.tradeMeasureId, (prefixCount.get(p.tradeMeasureId) ?? 0) + 1);
  }
  const out = measures.map((m) => ({
    id: m.id,
    name: m.name,
    authority: m.authority,
    program: m.program,
    scope: m.scope,
    countries: m.countries,
    effectiveDate: m.effectiveDate,
    endDate: m.endDate,
    sailedOnOrAfter: m.sailedOnOrAfter,
    sailedOnOrBefore: m.sailedOnOrBefore,
    prefixes: prefixCount.get(m.id) ?? 0,
    codes: codesByMeasure.get(m.id) ?? [],
  }));
  console.log(JSON.stringify(out, null, 1));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
