// The quote re-analysis a tariff apply triggers: for every SKU the change
// can touch — carried on at least one entry, not archived, holding at least
// one live quote — rebuild the sourcing comparison (quotes/compare.ts)
// under the measures in force just before the change and under the change
// itself, and when the cheapest option moved, open a quote_reconsider
// review item for a human. Runs AFTER the apply transaction commits, next
// to the entry re-audit, and is idempotent by construction: an item is
// only ever opened for a fresh difference, and a rerun supersedes it with
// the same numbers rather than stacking duplicates.
//
// Both comparisons are derived on read from the effective-dated reference
// tables — nothing about "before" is stored anywhere. An in-place
// correction ("this rate was always X") therefore never fires: before and
// after are the same window.
//
// Relative imports on purpose — reachable from tsx scripts.

import { and, asc, desc, eq, exists, inArray, isNull, ne, sql } from "drizzle-orm";

import type { DbClient } from "../db";
import * as schema from "../db/schema";
import { normalizeHts } from "../duty/calculator";
import { loadReferenceDataForOrg } from "../duty/reference";
import { dayAfter, dayBefore } from "../effective-dating";
import { partUsedOnEntrySql } from "../parts/usage-sql";
import {
  buildQuoteComparison,
  buildReconsiderProposal,
  diffComparisons,
  type ComparisonInput,
  type HtsCandidateInput,
} from "./compare";
import { openReconsiderItem } from "./service";

export type TariffChangeScope = {
  /** What changed, for the review card ("Section 301 List 4A", "Base
   *  schedule 2026HTSRev12"). */
  label: string;
  /** Ch99 measure prefixes the change reaches; null = every code. */
  prefixes: string[] | null;
  /** Exact base-schedule digits touched (base releases). */
  digits?: string[];
  /** The window dates the change introduces (effective dates, the day
   *  after an end date). Empty = today. */
  effectiveDates: string[];
};

export type ReconsiderSweepSummary = {
  partsChecked: number;
  opened: number;
};

const isoToday = () => new Date().toISOString().slice(0, 10);
const isIsoDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The two evaluation dates: the day before the change's earliest window
 *  opens (what the org was pricing under), and the latest window date or
 *  today, whichever is later (what the change makes true). */
export function resolveChangeWindow(
  effectiveDates: string[],
  now: string = isoToday(),
): { asOfBefore: string; asOfAfter: string } {
  const dates = effectiveDates.filter(isIsoDate).sort();
  const earliest = dates[0] ?? now;
  const latest = dates[dates.length - 1] ?? now;
  return {
    asOfBefore: dayBefore(earliest),
    asOfAfter: latest > now ? latest : now,
  };
}

/** The window dates a staged measure change introduces: its effective
 *  date, and the first day after an end date (the day the measure stops
 *  charging). */
export function proposalChangeDates(proposed: {
  effectiveDate: string | null;
  endDate: string | null;
}): string[] {
  const dates: string[] = [];
  if (isIsoDate(proposed.effectiveDate)) dates.push(proposed.effectiveDate);
  if (isIsoDate(proposed.endDate)) dates.push(dayAfter(proposed.endDate));
  return dates;
}

/** Does any of the part's potential codes fall under the change? */
export function partInScope(
  digits: string[],
  scope: Pick<TariffChangeScope, "prefixes" | "digits">,
): boolean {
  if (scope.prefixes === null) return true;
  const exact = new Set(scope.digits ?? []);
  const prefixes = scope.prefixes.filter((p) => p.length > 0);
  return digits.some(
    (d) => exact.has(d) || prefixes.some((p) => d.startsWith(p)),
  );
}

const CHUNK = 500;

export async function sweepQuoteReconsider(
  db: DbClient,
  scope: TariffChangeScope,
): Promise<ReconsiderSweepSummary> {
  const { asOfBefore, asOfAfter } = resolveChangeWindow(scope.effectiveDates);

  // Candidate SKUs across every org (reference data is global): in use on
  // an entry (the Parts page's Active predicate — 7501 line, tariff-sheet
  // row, or invoice attached to an entry), still in the catalog, with
  // something to compare against.
  const parts = await db
    .select({
      id: schema.parts.id,
      orgId: schema.parts.orgId,
      sku: schema.parts.sku,
      name: schema.parts.name,
      htsCode: schema.parts.htsCode,
      htsCodeProvisional: schema.parts.htsCodeProvisional,
    })
    .from(schema.parts)
    .where(
      and(
        ne(schema.parts.status, "archived"),
        partUsedOnEntrySql(db),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.quoteLines)
            .where(
              and(
                eq(schema.quoteLines.partId, schema.parts.id),
                ne(schema.quoteLines.status, "superseded"),
              ),
            ),
        ),
      ),
    );
  if (parts.length === 0) return { partsChecked: 0, opened: 0 };

  const partIds = parts.map((p) => p.id);
  const sourcesByPart = new Map<string, ComparisonInput["sources"]>();
  const quotesByPart = new Map<string, ComparisonInput["quotes"]>();
  const candidatesByPart = new Map<string, HtsCandidateInput[]>();

  for (let i = 0; i < partIds.length; i += CHUNK) {
    const chunk = partIds.slice(i, i + CHUNK);
    const [sources, lines, runs] = await Promise.all([
      db.query.partSources.findMany({
        where: and(
          inArray(schema.partSources.partId, chunk),
          isNull(schema.partSources.validTo),
        ),
        with: { vendor: { columns: { name: true } } },
      }),
      db.query.quoteLines.findMany({
        where: inArray(schema.quoteLines.partId, chunk),
        with: {
          quoteSheet: {
            columns: { vendorId: true, supplierName: true, quoteDate: true },
          },
        },
      }),
      db.query.htsClassifications.findMany({
        where: and(
          eq(schema.htsClassifications.status, "completed"),
          inArray(schema.htsClassifications.partId, chunk),
        ),
        orderBy: desc(schema.htsClassifications.id),
        with: {
          candidates: { orderBy: asc(schema.htsClassificationCandidates.position) },
        },
      }),
    ]);
    for (const s of sources) {
      const list = sourcesByPart.get(s.partId) ?? [];
      list.push({
        sourceId: s.id,
        vendorId: s.vendorId,
        vendorName: s.vendor.name,
        unitCost: s.unitCost,
        countryOfOrigin: s.countryOfOrigin,
      });
      sourcesByPart.set(s.partId, list);
    }
    for (const l of lines) {
      const list = quotesByPart.get(l.partId) ?? [];
      list.push({
        quoteLineId: l.id,
        vendorId: l.quoteSheet.vendorId,
        supplierName: l.quoteSheet.supplierName,
        quoteDate: l.quoteSheet.quoteDate,
        status: l.status,
        unitCost: l.unitCost,
        currency: l.currency,
        countryOfOrigin: l.countryOfOrigin,
      });
      quotesByPart.set(l.partId, list);
    }
    // Newest run first (uuidv7 ids): the first seen per part is its latest.
    for (const run of runs) {
      if (candidatesByPart.has(run.partId)) continue;
      candidatesByPart.set(
        run.partId,
        run.candidates.map((c) => ({
          code: c.code,
          codeDigits: c.codeDigits,
          confidence: c.confidence === null ? null : Number(c.confidence),
        })),
      );
    }
  }

  const byOrg = new Map<string, typeof parts>();
  for (const part of parts) {
    const candidates = candidatesByPart.get(part.id) ?? [];
    const digits = [
      ...(part.htsCode === null ? [] : [normalizeHts(part.htsCode)]),
      ...candidates.map((c) => c.codeDigits),
    ];
    if (!partInScope(digits, scope)) continue;
    const list = byOrg.get(part.orgId) ?? [];
    list.push(part);
    byOrg.set(part.orgId, list);
  }

  let partsChecked = 0;
  let opened = 0;
  for (const [orgId, orgParts] of byOrg) {
    const ref = await loadReferenceDataForOrg(db, orgId);
    for (const part of orgParts) {
      partsChecked += 1;
      const input: ComparisonInput = {
        part: { htsCode: part.htsCode, htsCodeProvisional: part.htsCodeProvisional },
        candidates: candidatesByPart.get(part.id) ?? [],
        sources: sourcesByPart.get(part.id) ?? [],
        quotes: quotesByPart.get(part.id) ?? [],
      };
      const before = buildQuoteComparison(input, ref, asOfBefore);
      const after = buildQuoteComparison(input, ref, asOfAfter);
      const signal = diffComparisons(before, after);
      if (!signal) continue;
      const proposal = buildReconsiderProposal(
        { sku: part.sku, partName: part.name, changeLabel: scope.label },
        before,
        after,
        signal,
      );
      await db.transaction((tx) =>
        openReconsiderItem(tx, orgId, part.id, proposal),
      );
      opened += 1;
    }
  }
  return { partsChecked, opened };
}
