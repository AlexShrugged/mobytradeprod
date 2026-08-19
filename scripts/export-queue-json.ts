// Read-only JSON export of the pending tariff review queue, per-member:
// everything needed to plan a bulk approval offline (ids, codes, proposals,
// evidence snippets, extraction chips). No writes.
//
// Run: DATABASE_URL=postgres://... npx tsx scripts/export-queue-json.ts > queue.json
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, schema } from "../src/lib/db";
import type {
  ProposedMeasureChange,
  RevisionEvidence,
} from "../src/lib/tariff-sync/types";

async function main() {
  const items = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_group"),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  const groups = await db.query.measureRevisionGroups.findMany({
    where: inArray(
      schema.measureRevisionGroups.id,
      items.length > 0 ? items.map((i) => i.subjectId) : ["-"],
    ),
    with: { announcement: true },
  });
  const members = await db.query.measureRevisions.findMany({
    where: and(
      inArray(
        schema.measureRevisions.groupId,
        groups.length > 0 ? groups.map((g) => g.id) : ["-"],
      ),
      isNull(schema.measureRevisions.appliedAt),
      isNull(schema.measureRevisions.supersededAt),
    ),
  });
  const byGroup = new Map<string, typeof members>();
  for (const m of members) {
    if (!m.groupId) continue;
    (byGroup.get(m.groupId) ?? byGroup.set(m.groupId, []).get(m.groupId)!).push(m);
  }

  const out = groups.map((g) => ({
    groupId: g.id,
    authority: g.authority,
    prefix: g.ch99Prefix,
    title: g.title,
    sourceRef: g.announcement.sourceRef,
    members: (byGroup.get(g.id) ?? [])
      .sort((a, b) => (a.ch99Code ?? "").localeCompare(b.ch99Code ?? ""))
      .map((m) => {
        const p = m.proposed as ProposedMeasureChange;
        const e = m.evidence as RevisionEvidence | null;
        return {
          revisionId: m.id,
          changeType: m.changeType,
          ch99Code: m.ch99Code,
          authority: m.authority,
          name: p.name,
          program: p.program ?? null,
          scope: p.scope,
          countries: p.countries,
          countriesExcluded: p.countriesExcluded ?? null,
          effectiveDate: p.effectiveDate,
          endDate: p.endDate,
          sailedOnOrAfter: p.sailedOnOrAfter,
          sailedOnOrBefore: p.sailedOnOrBefore,
          rate: p.rate,
          rateType: p.rateType ?? "ad_valorem",
          rateText: p.rateText ?? null,
          exemption: p.exemption,
          worldwide: p.worldwide ?? null,
          description: (e?.description ?? "").slice(0, 300),
          highlights: (e?.highlights ?? []).map((h) => ({
            kind: h.kind,
            isoDate: h.isoDate,
          })),
          extraction: e?.extraction
            ? {
                extractor: e.extraction.extractor,
                effectiveDate: e.extraction.effectiveDate,
                endDate: e.extraction.endDate,
                countries: e.extraction.countries,
              }
            : null,
        };
      }),
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
