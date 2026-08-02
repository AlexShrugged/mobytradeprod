// Loads the live reference state the differ compares a release against:
// one snapshot per Chapter 99 digits, backed by the measure whose window is
// LATEST (rate versioning keeps older windows for historical entries; the
// diff only ever concerns the current line). Also loads the current
// base-schedule windows the base ETL diffs against.
//
// Relative imports on purpose — reachable from the tsx seed script.

import { and, eq, isNotNull, isNull } from "drizzle-orm";

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
      scope: m.scope,
      countries: m.countries,
      effectiveDate: m.effectiveDate,
      endDate: m.endDate,
      sailedOnOrAfter: m.sailedOnOrAfter,
      sailedOnOrBefore: m.sailedOnOrBefore,
      rate: h.rate === null ? null : Number(h.rate),
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

/** Pending tariff revisions with their queue items, for hash-dedupe and
 *  supersession. */
export async function loadOpenRevisions(db: DbClient): Promise<OpenRevisionRef[]> {
  const items = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_revision"),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  if (items.length === 0) return [];

  const out: OpenRevisionRef[] = [];
  for (const item of items) {
    const revision = await db.query.measureRevisions.findFirst({
      where: and(
        eq(schema.measureRevisions.id, item.subjectId),
        isNull(schema.measureRevisions.appliedAt),
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
    }));
}
