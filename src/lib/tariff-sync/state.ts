// Loads the live reference state the differ compares a release against:
// one snapshot per Chapter 99 digits, backed by the measure whose window is
// LATEST (rate versioning keeps older windows for historical entries; the
// diff only ever concerns the current line). Also loads the current
// base-schedule windows the base ETL diffs against.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import * as schema from "../db/schema";
import type { DbClient } from "../duty/reference";
import type {
  CurrentBaseWindow,
  LiveMeasureSnapshot,
  OpenRevisionRef,
  TariffSyncState,
} from "./types";

export async function loadTariffSyncState(db: DbClient): Promise<TariffSyncState> {
  const [measureRows, ch99Rows, prefixRows] = await Promise.all([
    db.query.tradeMeasures.findMany(),
    db.query.htsCodes.findMany({
      where: isNotNull(schema.htsCodes.tradeMeasureId),
    }),
    db.query.tradeMeasureHts.findMany(),
  ]);

  const measureById = new Map(measureRows.map((m) => [m.id, m]));
  const prefixesByMeasure = new Map<string, string[]>();
  for (const p of prefixRows) {
    const list = prefixesByMeasure.get(p.tradeMeasureId) ?? [];
    list.push(p.htsPrefix);
    prefixesByMeasure.set(p.tradeMeasureId, list);
  }

  const byDigits = new Map<string, LiveMeasureSnapshot>();
  for (const h of ch99Rows) {
    const m = h.tradeMeasureId ? measureById.get(h.tradeMeasureId) : undefined;
    if (!m) continue;
    const snapshot: LiveMeasureSnapshot = {
      measureId: m.id,
      ch99Code: h.code,
      ch99Digits: h.codeDigits,
      name: m.name,
      authority: m.authority,
      program: m.program ?? null,
      scope: m.scope,
      countries: m.countries,
      countriesExcluded: m.countriesExcluded ?? null,
      effectiveDate: m.effectiveDate,
      endDate: m.endDate,
      sailedOnOrAfter: m.sailedOnOrAfter,
      sailedOnOrBefore: m.sailedOnOrBefore,
      rate: h.rate === null ? null : Number(h.rate),
      rateType: h.rateType,
      rateText: h.col1General,
      exemption: h.exemption,
      description: h.description,
      prefixes: prefixesByMeasure.get(m.id) ?? [],
    };
    const prev = byDigits.get(h.codeDigits);
    if (!prev || prev.effectiveDate < snapshot.effectiveDate) {
      byDigits.set(h.codeDigits, snapshot);
    }
  }

  return { byDigits };
}

/** Pending tariff revisions, for hash-dedupe and supersession. One uniform
 *  openness predicate — not applied, not superseded — reached two ways:
 *  individual revisions through their pending tariff_measure_revision item,
 *  grouped members through their group's pending tariff_measure_group item
 *  (they carry no per-revision item; reviewItemId is null). */
export async function loadOpenRevisions(db: DbClient): Promise<OpenRevisionRef[]> {
  const items = await db.query.reviewItems.findMany({
    where: and(
      inArray(schema.reviewItems.itemType, [
        "tariff_measure_revision",
        "tariff_measure_group",
      ]),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  if (items.length === 0) return [];

  const out: OpenRevisionRef[] = [];

  for (const item of items.filter((i) => i.itemType === "tariff_measure_revision")) {
    const revision = await db.query.measureRevisions.findFirst({
      where: and(
        eq(schema.measureRevisions.id, item.subjectId),
        isNull(schema.measureRevisions.appliedAt),
        isNull(schema.measureRevisions.supersededAt),
      ),
    });
    if (!revision) continue;
    out.push({
      revisionId: revision.id,
      reviewItemId: item.id,
      announcementId: revision.announcementId,
      ch99Digits: revision.ch99Code
        ? revision.ch99Code.replace(/\D/g, "")
        : null,
      contentHash: revision.contentHash,
    });
  }

  const groupIds = items
    .filter((i) => i.itemType === "tariff_measure_group")
    .map((i) => i.subjectId);
  if (groupIds.length > 0) {
    const members = await db.query.measureRevisions.findMany({
      where: and(
        inArray(schema.measureRevisions.groupId, groupIds),
        isNull(schema.measureRevisions.appliedAt),
        isNull(schema.measureRevisions.supersededAt),
      ),
    });
    for (const revision of members) {
      out.push({
        revisionId: revision.id,
        reviewItemId: null,
        announcementId: revision.announcementId,
        ch99Digits: revision.ch99Code
          ? revision.ch99Code.replace(/\D/g, "")
          : null,
        contentHash: revision.contentHash,
      });
    }
  }

  return out;
}

/** The current (valid_to null) base-schedule window per code — the live
 *  side of the base ETL's diff. Chapter 99 measure lines never appear here
 *  (trade_measure_id non-null; measure windows govern them). */
export async function loadCurrentBaseWindows(
  db: DbClient,
): Promise<CurrentBaseWindow[]> {
  const rows = await db.query.htsCodes.findMany({
    where: and(
      isNull(schema.htsCodes.tradeMeasureId),
      isNull(schema.htsCodes.validTo),
    ),
  });
  return rows
    .filter((r) => r.chapter >= 1 && r.chapter <= 97)
    .map((r) => ({
      codeDigits: r.codeDigits,
      code: r.code,
      description: r.description,
      rate: r.rate === null ? null : Number(r.rate),
      validFrom: r.validFrom,
      release: r.release,
    }));
}
