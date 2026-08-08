// Loads the tariff reference tables into the in-memory ReferenceData shape
// the calculator consumes. Takes the db handle as a parameter (rather than
// importing the singleton) so it works from route handlers, the auditor
// inside a transaction, and the seed script's standalone drizzle instance
// alike.
//
// Two loaders share one pure assembly step (buildReferenceData):
//  - loadReferenceData: the FULL schedule. Only for consumers whose job is a
//    schedule-wide scan (the stub classifier's candidate pool, the stub
//    processor, the seed). O(hts_codes) — at a real ~30k-row USITC base
//    schedule this is not a per-request loader.
//  - loadReferenceDataScoped / loadReferenceDataForOrg: full Chapter 99 +
//    measures + stacking (small, hundreds of rows) plus base-schedule
//    windows for ONLY the digits an org can reference. This is the
//    per-request path; loadOrgHtsDigits defines the digit universe.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { DbClient } from "../db";
import * as schema from "../db/schema";
import { normalizeHts } from "./calculator";
import type { HtsRef, MeasureRef, ReferenceData, StackingRuleRef } from "./types";

// Re-exported so domain modules (auditor, tariff-sync) keep importing the
// db-handle type from here, as they did in mobynew. The type itself lives in
// src/lib/db/index.ts, generalized over the query-result HKT so the same
// code runs on node-postgres and PGlite.
export type { DbClient };

export type HtsCodeRow = typeof schema.htsCodes.$inferSelect;
export type TradeMeasureRow = typeof schema.tradeMeasures.$inferSelect;
export type TradeMeasureHtsRow = typeof schema.tradeMeasureHts.$inferSelect;
export type StackingRuleRow = typeof schema.stackingRules.$inferSelect;

/** Pure assembly of the ReferenceData bag from raw table rows. The scoped
 *  and full loaders differ only in which hts_codes rows they feed in; the
 *  derived maps are byte-identical for any digits present in both. */
export function buildReferenceData(
  htsRows: HtsCodeRow[],
  measureRows: TradeMeasureRow[],
  prefixRows: TradeMeasureHtsRow[],
  stackingRows: StackingRuleRow[],
): ReferenceData {
  const measureById = new Map(measureRows.map((m) => [m.id, m]));

  const toRef = (h: HtsCodeRow): HtsRef => ({
    code: h.code,
    codeDigits: h.codeDigits,
    description: h.description,
    chapter: h.chapter,
    rateType: h.rateType,
    rate: h.rate === null ? null : Number(h.rate),
    exemption: h.exemption,
    tradeMeasureId: h.tradeMeasureId,
    validFrom: h.validFrom,
    validTo: h.validTo,
  });

  // Chapter 99 digits may repeat across a measure's window rows (rate
  // versioning); insert oldest-window first so the row backing the LATEST
  // window wins the map. Display consumers only — the calculator's measure
  // math never reads Ch99 rows through this map. Base-schedule codes may
  // also repeat (change-tiling windows); only the CURRENT window (valid_to
  // null) represents a code here — closed windows are history, reachable
  // through baseWindowsByDigits and entry-date resolution.
  const htsByDigits = new Map<string, HtsRef>(
    [...htsRows]
      .filter((h) => h.tradeMeasureId !== null || h.validTo === null)
      .sort((a, b) => {
        const aEff = a.tradeMeasureId
          ? (measureById.get(a.tradeMeasureId)?.effectiveDate ?? "")
          : "";
        const bEff = b.tradeMeasureId
          ? (measureById.get(b.tradeMeasureId)?.effectiveDate ?? "")
          : "";
        return aEff.localeCompare(bEff) || a.id.localeCompare(b.id);
      })
      .map((h) => [h.codeDigits, toRef(h)]),
  );

  // Every base-schedule window (open and closed), keyed by digits, for
  // entry-date-aware base-rate resolution. Newest window first — windows
  // for one code never overlap (base-apply enforces the tiling), so order
  // only makes the lookup deterministic.
  const baseWindowsByDigits = new Map<string, HtsRef[]>();
  for (const h of htsRows) {
    if (h.tradeMeasureId !== null) continue; // Ch99: measure windows govern
    const list = baseWindowsByDigits.get(h.codeDigits) ?? [];
    list.push(toRef(h));
    baseWindowsByDigits.set(h.codeDigits, list);
  }
  for (const list of baseWindowsByDigits.values()) {
    list.sort((a, b) => (b.validFrom ?? "").localeCompare(a.validFrom ?? ""));
  }

  const prefixesByMeasure = new Map<string, string[]>();
  for (const p of prefixRows) {
    const list = prefixesByMeasure.get(p.tradeMeasureId) ?? [];
    list.push(p.htsPrefix);
    prefixesByMeasure.set(p.tradeMeasureId, list);
  }

  const exclusionsByMeasure = new Map<string, string[]>();
  // Entry-date windows in which each exemption Ch99 digits string is live —
  // isExemptionActive resolves against these so a declared exclusion code
  // is only "always allowed" on entries its measure window actually covers.
  const exemptionsByDigits = new Map<
    string,
    { effectiveDate: string; endDate: string | null }[]
  >();
  for (const h of htsRows) {
    if (!h.tradeMeasureId || !h.exemption) continue;
    const list = exclusionsByMeasure.get(h.tradeMeasureId) ?? [];
    list.push(h.codeDigits);
    exclusionsByMeasure.set(h.tradeMeasureId, list);
    const m = measureById.get(h.tradeMeasureId);
    if (m) {
      const windows = exemptionsByDigits.get(h.codeDigits) ?? [];
      windows.push({ effectiveDate: m.effectiveDate, endDate: m.endDate });
      exemptionsByDigits.set(h.codeDigits, windows);
    }
  }

  const measures: MeasureRef[] = [];
  for (const h of htsRows) {
    // A null rate no longer drops the measure: non-ad-valorem (specific/
    // compound) measure lines are tracked presence-only — expected on
    // covered entries, amount not computable. Ad-valorem rows with a null
    // rate should not exist (apply refuses them); skip defensively.
    if (!h.tradeMeasureId || h.exemption) continue;
    if (h.rate === null && h.rateType === "ad_valorem") continue;
    const m = measureById.get(h.tradeMeasureId);
    if (!m) continue;
    measures.push({
      id: m.id,
      name: m.name,
      authority: m.authority,
      scope: m.scope,
      countries: m.countries,
      countriesExcluded: m.countriesExcluded ?? null,
      effectiveDate: m.effectiveDate,
      endDate: m.endDate,
      sailedOnOrAfter: m.sailedOnOrAfter,
      sailedOnOrBefore: m.sailedOnOrBefore,
      inLieuOfBaseDuty: m.inLieuOfBaseDuty,
      ch99Code: h.code,
      ch99Digits: h.codeDigits,
      rate: h.rate === null ? null : Number(h.rate),
      rateType: h.rateType,
      rateText: h.col1General,
      exclusionDigits: exclusionsByMeasure.get(m.id) ?? [],
      prefixes: prefixesByMeasure.get(m.id) ?? [],
    });
  }

  // uuidv7 ids sort by creation time, so (effectiveDate, id) reproduces the
  // legacy "rules fire in insertion order" semantics.
  const stackingRules: StackingRuleRef[] = [...stackingRows]
    .sort(
      (a, b) =>
        a.effectiveDate.localeCompare(b.effectiveDate) ||
        a.id.localeCompare(b.id),
    )
    .map((r) => ({
      winnerAuthority: r.winnerAuthority,
      loserAuthority: r.loserAuthority,
      reason: r.reason,
      effectiveDate: r.effectiveDate,
      endDate: r.endDate,
    }));

  return {
    htsByDigits,
    baseWindowsByDigits,
    exemptionsByDigits,
    measures,
    stackingRules,
  };
}

export async function loadReferenceData(db: DbClient): Promise<ReferenceData> {
  const [htsRows, measureRows, prefixRows, stackingRows] = await Promise.all([
    db.query.htsCodes.findMany(),
    db.query.tradeMeasures.findMany(),
    db.query.tradeMeasureHts.findMany(),
    db.query.stackingRules.findMany(),
  ]);
  return buildReferenceData(htsRows, measureRows, prefixRows, stackingRows);
}

// inArray chunk size — bounded parameter lists on both drivers.
const DIGIT_CHUNK = 500;

/** Scoped loader: the whole Chapter 99 / measure / stacking reference plus
 *  base-schedule rows (ALL windows, open and closed — entry-date resolution
 *  needs history) for only the given digits. Digits absent from the schedule
 *  simply produce no rows, which downstream reads as "not in reference" —
 *  the same contract as the full loader. */
export async function loadReferenceDataScoped(
  db: DbClient,
  baseDigits: Iterable<string>,
): Promise<ReferenceData> {
  const digits = [...new Set(baseDigits)].filter((d) => d.length > 0);

  const chunkReads: Promise<HtsCodeRow[]>[] = [];
  for (let i = 0; i < digits.length; i += DIGIT_CHUNK) {
    const chunk = digits.slice(i, i + DIGIT_CHUNK);
    chunkReads.push(
      db.query.htsCodes.findMany({
        where: and(
          isNull(schema.htsCodes.tradeMeasureId),
          inArray(schema.htsCodes.codeDigits, chunk),
        ),
      }),
    );
  }

  const [ch99Rows, measureRows, prefixRows, stackingRows, ...baseChunks] =
    await Promise.all([
      db.query.htsCodes.findMany({
        where: isNotNull(schema.htsCodes.tradeMeasureId),
      }),
      db.query.tradeMeasures.findMany(),
      db.query.tradeMeasureHts.findMany(),
      db.query.stackingRules.findMany(),
      ...chunkReads,
    ] as const);

  return buildReferenceData(
    [...ch99Rows, ...baseChunks.flat()],
    measureRows,
    prefixRows,
    stackingRows,
  );
}

/** The org's HTS digit universe: every code its data can ask the reference
 *  about. Declared entry-line digits, the parts catalog's current
 *  projections, and every classification window (audits and variance
 *  counterfactuals resolve historical windows too). Deliberately org-wide
 *  rather than per-entry: one shape serves entries, variance, parts, sweeps,
 *  and projections alike, and the union is a few hundred values. */
export async function loadOrgHtsDigits(
  db: DbClient,
  orgId: string,
): Promise<string[]> {
  const [lineDigits, partCodes, classificationCodes] = await Promise.all([
    db
      .selectDistinct({ digits: schema.entryLineItems.htsCodeDigits })
      .from(schema.entryLineItems)
      .where(eq(schema.entryLineItems.orgId, orgId)),
    db
      .selectDistinct({ code: schema.parts.htsCode })
      .from(schema.parts)
      .where(and(eq(schema.parts.orgId, orgId), isNotNull(schema.parts.htsCode))),
    db
      .selectDistinct({ code: schema.partClassifications.htsCode })
      .from(schema.partClassifications)
      .where(eq(schema.partClassifications.orgId, orgId)),
  ]);

  const digits = new Set<string>();
  for (const r of lineDigits) digits.add(r.digits);
  for (const r of partCodes) if (r.code) digits.add(normalizeHts(r.code));
  for (const r of classificationCodes) digits.add(normalizeHts(r.code));
  return [...digits];
}

/** Convenience composition for lib-layer callers (auditor sweeps, re-audits
 *  after reference writes). Request-scoped memoization lives in
 *  src/lib/db/queries/reference.ts, not here — this module stays tsx-safe. */
export async function loadReferenceDataForOrg(
  db: DbClient,
  orgId: string,
): Promise<ReferenceData> {
  return loadReferenceDataScoped(db, await loadOrgHtsDigits(db, orgId));
}
