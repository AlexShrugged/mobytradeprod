// Loads the tariff reference tables into the in-memory ReferenceData shape
// the calculator consumes. Takes the db handle as a parameter (rather than
// importing the singleton) so it works from route handlers, the auditor
// inside a transaction, and the seed script's standalone drizzle instance
// alike.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import type { DbClient } from "../db";
import type { HtsRef, MeasureRef, ReferenceData, StackingRuleRef } from "./types";

// Re-exported so domain modules (auditor, tariff-sync) keep importing the
// db-handle type from here, as they did in mobynew. The type itself lives in
// src/lib/db/index.ts, generalized over the query-result HKT so the same
// code runs on node-postgres and PGlite.
export type { DbClient };

export async function loadReferenceData(db: DbClient): Promise<ReferenceData> {
  const [htsRows, measureRows, prefixRows, stackingRows] = await Promise.all([
    db.query.htsCodes.findMany(),
    db.query.tradeMeasures.findMany(),
    db.query.tradeMeasureHts.findMany(),
    db.query.stackingRules.findMany(),
  ]);

  const measureById = new Map(measureRows.map((m) => [m.id, m]));

  const toRef = (h: (typeof htsRows)[number]): HtsRef => ({
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
  for (const h of htsRows) {
    if (!h.tradeMeasureId || !h.exemption) continue;
    const list = exclusionsByMeasure.get(h.tradeMeasureId) ?? [];
    list.push(h.codeDigits);
    exclusionsByMeasure.set(h.tradeMeasureId, list);
  }

  const measures: MeasureRef[] = [];
  for (const h of htsRows) {
    if (!h.tradeMeasureId || h.exemption || h.rate === null) continue;
    const m = measureById.get(h.tradeMeasureId);
    if (!m) continue;
    measures.push({
      id: m.id,
      name: m.name,
      authority: m.authority,
      scope: m.scope,
      countries: m.countries,
      effectiveDate: m.effectiveDate,
      endDate: m.endDate,
      sailedOnOrAfter: m.sailedOnOrAfter,
      sailedOnOrBefore: m.sailedOnOrBefore,
      inLieuOfBaseDuty: m.inLieuOfBaseDuty,
      ch99Code: h.code,
      ch99Digits: h.codeDigits,
      rate: Number(h.rate),
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

  return { htsByDigits, baseWindowsByDigits, measures, stackingRules };
}
