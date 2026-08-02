import "server-only";

import { and, asc, count, eq, inArray } from "drizzle-orm";

import type { ReviewProposal } from "@/lib/classification/service";
import { db, schema } from "@/lib/db";
import type {
  EntryStatus,
  HtsClassification,
  HtsClassificationCandidate,
  Part,
  QuoteLineStatus,
  ReviewItem,
} from "@/lib/db/schema";
import { normalizeHts } from "@/lib/duty/calculator";
import { loadReferenceData } from "@/lib/duty/reference";
import {
  computeEstimatedLandedCost,
  type EstimateInput,
} from "@/lib/landed-cost/estimate";
import { rollupBySku, type RollupLine } from "@/lib/landed-cost/rollup";
import { getCurrentOrgId } from "@/lib/org";

// The Parts page payload. mobynew's pattern: one query round per concern
// (catalog, reference data, quote lines, actual entry lines, open review
// items), assembled in code — no fan-out per part.

const centsOf = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

const today = (): string => new Date().toISOString().slice(0, 10);

// Actuals mean "what we really paid": the entry has been filed with CBP.
// Draft entries never feed the last-actual column.
const ACTUAL_ENTRY_STATUSES: readonly EntryStatus[] = [
  "filed",
  "released",
  "liquidated",
];

function estimateInputOf(part: Part): EstimateInput {
  return {
    unitCostCents: centsOf(part.unitCost),
    htsDigits: part.htsCode === null ? null : normalizeHts(part.htsCode),
    countryOfOrigin: part.countryOfOrigin,
  };
}

// ---------------------------------------------------------------- part rows

/** One quote line under a part — THE unit rendered in the expansion panel. */
export type PartQuoteRow = {
  id: string;
  quoteSheetId: string;
  lineNumber: number;
  sku: string;
  description: string | null;
  unitCost: string;
  currency: string;
  countryOfOrigin: string | null;
  /** Supplier's claim — reference only, never an estimate/audit driver. */
  htsCode: string | null;
  moq: string | null;
  leadTimeDays: number | null;
  status: QuoteLineStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  appliedAt: Date | null;
  /** This line created its (draft) part. */
  partCreated: boolean;
  // Sheet context, denormalized so the row renders without a join lookup.
  supplierName: string | null;
  quoteDate: string | null;
  documentId: string | null;
  /** Estimated landed/unit at the QUOTE's cost + origin under the PART's
   *  committed HTS — the supplier's claimed HTS is shown for reference only,
   *  so quote estimates stay comparable to the catalog estimate. */
  estimatedPerUnitCents: number | null;
  estimateIncomplete: boolean;
  /** Quote cost minus current official cost, cents. Null when the part has
   *  no official cost yet or the quote is in a non-USD currency (the catalog
   *  cost is implicitly USD — cross-currency deltas would be noise). */
  deltaVsCurrentCents: number | null;
  /** Approved line with a newer received line for the same part — the human
   *  decision stands (approved lines are never auto-superseded), but the UI
   *  hints that fresher pricing is waiting. */
  newerReceivedExists: boolean;
};

export type PartQuoteCounts = {
  received: number;
  approved: number;
  applied: number;
};

export type PartRow = Part & {
  /** Estimated landed cost for one unit as of today (duty-inclusive). For
   *  draft parts this runs on quote-claimed data — display-only; the UI
   *  labels draft rows. */
  estimatedPerUnitCents: number | null;
  estimateIncomplete: boolean;
  /** Per-unit landed cost on the most recent filed entry carrying this SKU. */
  actualLatestPerUnitCents: number | null;
  actualLatestEntryNumber: string | null;
  actualLatestEntryDate: string | null;
  /** Pending review-queue item for this part, if any. */
  openReviewItemId: string | null;
  quoteCounts: PartQuoteCounts;
  /** Derived (never stored): an approved quote awaits its confirming PO. */
  pendingChanges: boolean;
  /** Derived: a received quote awaits a decision. */
  hasUnapproved: boolean;
  /** parts.status with the derived pending_changes overlay for active parts. */
  displayStatus: "draft" | "active" | "archived" | "pending_changes";
  /** All quote lines for this part, newest sheet first. Fetched for every
   *  part in ONE org-bounded query — simpler than lazy per-row loads for the
   *  single-page expansion model, and quote volume is small. */
  quotes: PartQuoteRow[];
};

export async function getParts(): Promise<PartRow[]> {
  const orgId = await getCurrentOrgId();

  const [parts, ref, quoteLines, actualLines, openItems] = await Promise.all([
    db.query.parts.findMany({
      where: eq(schema.parts.orgId, orgId),
      orderBy: asc(schema.parts.sku),
    }),
    loadReferenceData(db),
    db.query.quoteLines.findMany({
      where: eq(schema.quoteLines.orgId, orgId),
      with: {
        quoteSheet: {
          columns: {
            id: true,
            supplierName: true,
            quoteDate: true,
            documentId: true,
            createdAt: true,
          },
        },
      },
    }),
    fetchActualRollupLines(orgId),
    db.query.reviewItems.findMany({
      where: and(
        eq(schema.reviewItems.orgId, orgId),
        eq(schema.reviewItems.itemType, "hts_classification"),
        eq(schema.reviewItems.status, "pending"),
      ),
      columns: { id: true, subjectId: true },
    }),
  ]);

  const latestByPartId = new Map(
    rollupBySku(actualLines)
      .filter((r) => r.partId !== null)
      .map((r) => [r.partId as string, r.latest]),
  );
  const openItemByPartId = new Map(openItems.map((i) => [i.subjectId, i.id]));

  const linesByPartId = new Map<string, typeof quoteLines>();
  for (const line of quoteLines) {
    const list = linesByPartId.get(line.partId) ?? [];
    list.push(line);
    linesByPartId.set(line.partId, list);
  }

  const asOf = today();

  return parts.map((part) => {
    const partLines = linesByPartId.get(part.id) ?? [];
    // Newest sheet first (quote date, falling back to when we recorded the
    // sheet), newest line as the tiebreaker.
    const sorted = [...partLines].sort((a, b) => {
      const aKey =
        a.quoteSheet.quoteDate ?? a.quoteSheet.createdAt.toISOString().slice(0, 10);
      const bKey =
        b.quoteSheet.quoteDate ?? b.quoteSheet.createdAt.toISOString().slice(0, 10);
      if (aKey !== bKey) return aKey < bKey ? 1 : -1;
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return b.createdAt.getTime() - a.createdAt.getTime();
      }
      return a.lineNumber - b.lineNumber;
    });

    const counts: PartQuoteCounts = { received: 0, approved: 0, applied: 0 };
    let newestReceivedAt = 0;
    for (const l of partLines) {
      if (l.status === "received") {
        counts.received += 1;
        newestReceivedAt = Math.max(newestReceivedAt, l.createdAt.getTime());
      } else if (l.status === "approved") counts.approved += 1;
      else if (l.status === "applied") counts.applied += 1;
    }

    const partHtsDigits =
      part.htsCode === null ? null : normalizeHts(part.htsCode);
    const partCostCents = centsOf(part.unitCost);

    const quotes: PartQuoteRow[] = sorted.map((l) => {
      const quoteCostCents = centsOf(l.unitCost) as number;
      const estimated = computeEstimatedLandedCost(
        {
          unitCostCents: quoteCostCents,
          htsDigits: partHtsDigits,
          countryOfOrigin: l.countryOfOrigin ?? part.countryOfOrigin,
        },
        ref,
        asOf,
      );
      return {
        id: l.id,
        quoteSheetId: l.quoteSheetId,
        lineNumber: l.lineNumber,
        sku: l.sku,
        description: l.description,
        unitCost: l.unitCost,
        currency: l.currency,
        countryOfOrigin: l.countryOfOrigin,
        htsCode: l.htsCode,
        moq: l.moq,
        leadTimeDays: l.leadTimeDays,
        status: l.status,
        decidedBy: l.decidedBy,
        decidedAt: l.decidedAt,
        decisionNote: l.decisionNote,
        appliedAt: l.appliedAt,
        partCreated: l.partCreated,
        supplierName: l.quoteSheet.supplierName,
        quoteDate: l.quoteSheet.quoteDate,
        documentId: l.quoteSheet.documentId,
        estimatedPerUnitCents: estimated?.perUnitCents ?? null,
        estimateIncomplete: estimated?.incomplete ?? false,
        deltaVsCurrentCents:
          partCostCents !== null && l.currency === "USD"
            ? quoteCostCents - partCostCents
            : null,
        newerReceivedExists:
          l.status === "approved" &&
          newestReceivedAt > l.createdAt.getTime(),
      };
    });

    const estimated = computeEstimatedLandedCost(estimateInputOf(part), ref, asOf);
    const latest = latestByPartId.get(part.id);
    const pendingChanges = counts.approved > 0;

    return {
      ...part,
      estimatedPerUnitCents: estimated?.perUnitCents ?? null,
      estimateIncomplete: estimated?.incomplete ?? false,
      actualLatestPerUnitCents: latest?.perUnitCents ?? null,
      actualLatestEntryNumber: latest?.entryNumber ?? null,
      actualLatestEntryDate: latest?.entryDate ?? null,
      openReviewItemId: openItemByPartId.get(part.id) ?? null,
      quoteCounts: counts,
      pendingChanges,
      hasUnapproved: counts.received > 0,
      displayStatus:
        part.status === "active" && pendingChanges
          ? "pending_changes"
          : part.status,
      quotes,
    };
  });
}

/** Entry lines (with charges) from filed entries, shaped for rollupBySku.
 *  The entry-status filter runs in code — filtering a `with` relation would
 *  drop the charges join, and actual line volume is modest. */
async function fetchActualRollupLines(orgId: string): Promise<RollupLine[]> {
  const rows = await db.query.entryLineItems.findMany({
    where: eq(schema.entryLineItems.orgId, orgId),
    with: {
      charges: true,
      entry: {
        columns: { id: true, entryNumber: true, entryDate: true, status: true },
      },
    },
  });

  return rows
    .filter((li) => ACTUAL_ENTRY_STATUSES.includes(li.entry.status))
    .map((li) => ({
      partId: li.partId,
      sku: li.sku,
      entryId: li.entry.id,
      entryNumber: li.entry.entryNumber,
      entryDate: li.entry.entryDate,
      lineNumber: li.lineNumber,
      quantity: li.quantity === null ? null : Number(li.quantity),
      enteredValueCents: centsOf(li.enteredValue) ?? 0,
      charges: li.charges.map((c) => ({
        chargeType: c.chargeType,
        amountCents: centsOf(c.amount) ?? 0,
        htsCode: c.htsCode,
        rate: c.rate === null ? null : Number(c.rate),
      })),
    }));
}

// ------------------------------------------------------- HTS review queue

export type HtsReviewQueueItem = {
  item: ReviewItem;
  proposal: ReviewProposal;
  part: Part;
  classification:
    | (HtsClassification & { candidates: HtsClassificationCandidate[] })
    | null;
  /** Broker-vs-internal evidence: what entries actually declared for this
   *  part, with how many lines said so. */
  declaredCodes: { htsCode: string; lineCount: number }[];
};

export async function getHtsReviewQueue(): Promise<HtsReviewQueueItem[]> {
  const orgId = await getCurrentOrgId();
  const items = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.orgId, orgId),
      eq(schema.reviewItems.itemType, "hts_classification"),
      eq(schema.reviewItems.status, "pending"),
    ),
    orderBy: asc(schema.reviewItems.id), // uuidv7: oldest first
  });
  if (items.length === 0) return [];

  const partIds = [...new Set(items.map((i) => i.subjectId))];
  const classificationIds = items
    .map((i) => i.payloadId)
    .filter((id): id is string => id !== null);

  const [parts, classifications, declaredRows] = await Promise.all([
    db.query.parts.findMany({
      where: inArray(schema.parts.id, partIds),
    }),
    classificationIds.length > 0
      ? db.query.htsClassifications.findMany({
          where: inArray(schema.htsClassifications.id, classificationIds),
          with: {
            candidates: {
              orderBy: asc(schema.htsClassificationCandidates.position),
            },
          },
        })
      : Promise.resolve([]),
    db
      .select({
        partId: schema.entryLineItems.partId,
        htsCode: schema.entryLineItems.htsCode,
        lineCount: count(),
      })
      .from(schema.entryLineItems)
      .where(
        and(
          eq(schema.entryLineItems.orgId, orgId),
          inArray(schema.entryLineItems.partId, partIds),
        ),
      )
      .groupBy(schema.entryLineItems.partId, schema.entryLineItems.htsCode),
  ]);

  const partById = new Map(parts.map((p) => [p.id, p]));
  const classificationById = new Map(classifications.map((c) => [c.id, c]));
  const declaredByPart = new Map<
    string,
    { htsCode: string; lineCount: number }[]
  >();
  for (const row of declaredRows) {
    if (row.partId === null) continue;
    const list = declaredByPart.get(row.partId) ?? [];
    list.push({ htsCode: row.htsCode, lineCount: row.lineCount });
    declaredByPart.set(row.partId, list);
  }

  return items.flatMap((item) => {
    const part = partById.get(item.subjectId);
    if (!part) return [];
    return [
      {
        item,
        proposal: item.proposal as ReviewProposal,
        part,
        classification:
          item.payloadId !== null
            ? (classificationById.get(item.payloadId) ?? null)
            : null,
        declaredCodes: (declaredByPart.get(part.id) ?? []).sort(
          (a, b) => b.lineCount - a.lineCount,
        ),
      },
    ];
  });
}
