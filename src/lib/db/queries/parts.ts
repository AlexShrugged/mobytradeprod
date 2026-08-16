import "server-only";

import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
} from "drizzle-orm";

import type { ReviewProposal } from "@/lib/classification/service";
import { db, schema } from "@/lib/db";
import type {
  HtsClassification,
  HtsClassificationCandidate,
  Part,
  QuoteLineStatus,
  ReviewItem,
} from "@/lib/db/schema";
import { normalizeHts } from "@/lib/duty/calculator";
import { candidateDutySavingRate } from "@/lib/duty/candidate-delta";
import { getReferenceDataForOrg } from "./reference";
import { computeEstimatedLandedCost } from "@/lib/landed-cost/estimate";
import { rollupBySku, type RollupLine } from "@/lib/landed-cost/rollup";
import { getCurrentOrgId } from "@/lib/org";

// The Parts page payload. mobynew's pattern: one query round per concern
// (catalog, reference data, quote lines, actual entry lines, open review
// items), assembled in code — no fan-out per part.

const centsOf = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

const today = (): string => new Date().toISOString().slice(0, 10);

// Actuals mean "what we really paid": every entry qualifies — an entry row
// only exists because a 7501 was processed, so it is filed by construction
// (see entries/status.ts).

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
  /** Resolved sheet vendor — the source row a decided quote would write. */
  vendorId: string | null;
  quoteDate: string | null;
  documentId: string | null;
  /** Estimated landed/unit at the QUOTE's cost + origin under the PART's
   *  committed HTS — the supplier's claimed HTS is shown for reference only,
   *  so quote estimates stay comparable to the catalog estimate. Origin
   *  falls back to the sheet vendor's source COO when the line has none. */
  estimatedPerUnitCents: number | null;
  estimateIncomplete: boolean;
  /** Quote cost minus THIS VENDOR's current official cost (the (part,
   *  vendor) source row), cents. Null when that vendor has no source cost
   *  yet or the quote is in a non-USD currency (source costs are implicitly
   *  USD — cross-currency deltas would be noise). */
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

/** How much real import activity a (part, vendor) pair has behind it —
 *  distinct POs, invoices, and entries carrying this part from this vendor.
 *  Derived on read; "used" vendors (any count > 0) rank above quote-only
 *  vendors on the Parts page. */
export type PartVendorUsage = {
  poCount: number;
  invoiceCount: number;
  entryCount: number;
};

export type CentsRange = { min: number; max: number };

/** One (part, vendor) sourcing row — the unit rendered in the SourcesCard.
 *  Cost/COO are the catalog facts; the estimate derives from them under the
 *  part's committed HTS. */
export type PartSourceRow = {
  id: string;
  vendorId: string;
  vendorName: string;
  countryOfOrigin: string | null;
  unitCost: string | null;
  /** Estimated landed cost for one unit from THIS vendor as of today. */
  estimatedPerUnitCents: number | null;
  estimateIncomplete: boolean;
  /** Quote lines from this vendor for this part. */
  quoteCounts: PartQuoteCounts;
  /** Real activity (POs / invoices / entries) behind this (part, vendor). */
  usage: PartVendorUsage;
};

/** One suggested alternative code from the part's latest classifier run.
 *  The saving rate is derived duty math (never stored): the guaranteed
 *  duty-rate drop vs the current code under today's measures across every
 *  sourced origin, null when not strictly cheaper or undecidable. */
export type PartHtsSuggestion = {
  code: string;
  codeDigits: string;
  description: string | null;
  confidence: number | null;
  reason: string | null;
  savingRate: number | null;
};

/** The part's latest completed classifier run, shaped for the expansion
 *  card. Suggestions keep rank order and exclude the current code (a
 *  provisional auto-select equals candidate 0, so it renders as Current
 *  and drops out here). */
export type PartClassificationInfo = {
  classifiedAt: string;
  classifier: string;
  outcome: "certain" | "ambiguous" | "none";
  /** Confidence of the run's candidate matching the current code — the
   *  classifier's independent agreement with the catalog. Null when the
   *  run proposed no such candidate. */
  currentConfidence: number | null;
  suggestions: PartHtsSuggestion[];
};

export type PartRow = Part & {
  /** The part's vendor sources, vendor-name order. For draft parts these
   *  carry quote-claimed data — display-only; the UI labels draft rows. */
  sources: PartSourceRow[];
  /** Min/max across source costs (cents); null when no source has a cost.
   *  min === max when the vendors agree (or there is one). */
  costRangeCents: CentsRange | null;
  /** Min/max across source landed estimates (cents). Dual-sourcing spread
   *  is THE signal here — a CN and a VN source of one SKU can land far
   *  apart under country-gated measures. */
  estimatedRangeCents: CentsRange | null;
  /** True when any source's estimate is missing pieces. */
  estimateIncomplete: boolean;
  /** Per-unit landed cost on the most recent filed entry carrying this SKU. */
  actualLatestPerUnitCents: number | null;
  actualLatestEntryNumber: string | null;
  actualLatestEntryDate: string | null;
  /** Pending review-queue item for this part, if any. */
  openReviewItemId: string | null;
  /** The pending item's proposal kind — decides which review action the
   *  expansion card's Accept/Dismiss map to (accept/reject for
   *  suggestions, manual/acknowledge for confirmations). */
  openReviewKind: "suggestion" | "confirmation" | null;
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
  /** Latest completed classifier run; null = never classified. */
  classification: PartClassificationInfo | null;
};

export async function getParts(): Promise<PartRow[]> {
  const orgId = await getCurrentOrgId();

  const [
    parts,
    ref,
    quoteLines,
    partSources,
    actualLines,
    openItems,
    usage,
    classificationRuns,
  ] = await Promise.all([
      db.query.parts.findMany({
        where: eq(schema.parts.orgId, orgId),
        orderBy: asc(schema.parts.sku),
      }),
      getReferenceDataForOrg(),
      db.query.quoteLines.findMany({
        where: eq(schema.quoteLines.orgId, orgId),
        with: {
          quoteSheet: {
            columns: {
              id: true,
              supplierName: true,
              vendorId: true,
              quoteDate: true,
              documentId: true,
              createdAt: true,
            },
          },
        },
      }),
      db.query.partSources.findMany({
        // The parts page shows today's sourcing facts: current windows only.
        where: and(
          eq(schema.partSources.orgId, orgId),
          isNull(schema.partSources.validTo),
        ),
        with: { vendor: { columns: { name: true } } },
      }),
      fetchActualRollupLines(orgId),
      db.query.reviewItems.findMany({
        where: and(
          eq(schema.reviewItems.orgId, orgId),
          eq(schema.reviewItems.itemType, "hts_classification"),
          eq(schema.reviewItems.status, "pending"),
        ),
        columns: { id: true, subjectId: true, proposal: true },
      }),
      fetchVendorUsage(orgId),
      // Completed runs newest-first (uuidv7 ids order by time); the first
      // row seen per part below is its latest — the same latest-by-id
      // contract the review flow uses. Runs are user-triggered and few.
      db.query.htsClassifications.findMany({
        where: and(
          eq(schema.htsClassifications.orgId, orgId),
          eq(schema.htsClassifications.status, "completed"),
        ),
        orderBy: desc(schema.htsClassifications.id),
        with: {
          candidates: {
            orderBy: asc(schema.htsClassificationCandidates.position),
          },
        },
      }),
    ]);

  const latestClassificationByPartId = new Map<
    string,
    (typeof classificationRuns)[number]
  >();
  for (const run of classificationRuns) {
    if (!latestClassificationByPartId.has(run.partId)) {
      latestClassificationByPartId.set(run.partId, run);
    }
  }

  const latestByPartId = new Map(
    rollupBySku(actualLines)
      .filter((r) => r.partId !== null)
      .map((r) => [r.partId as string, r.latest]),
  );
  const openItemByPartId = new Map(
    openItems.map((i) => [
      i.subjectId,
      { id: i.id, kind: (i.proposal as ReviewProposal).kind },
    ]),
  );

  const linesByPartId = new Map<string, typeof quoteLines>();
  for (const line of quoteLines) {
    const list = linesByPartId.get(line.partId) ?? [];
    list.push(line);
    linesByPartId.set(line.partId, list);
  }

  const sourcesByPartId = new Map<string, typeof partSources>();
  for (const source of partSources) {
    const list = sourcesByPartId.get(source.partId) ?? [];
    list.push(source);
    sourcesByPartId.set(source.partId, list);
  }

  const asOf = today();
  const rangeOf = (values: (number | null)[]): CentsRange | null => {
    const present = values.filter((v): v is number => v !== null);
    if (present.length === 0) return null;
    return { min: Math.min(...present), max: Math.max(...present) };
  };

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
    const countsByVendor = new Map<string, PartQuoteCounts>();
    let newestReceivedAt = 0;
    for (const l of partLines) {
      const vendorId = l.quoteSheet.vendorId;
      let vendorCounts = vendorId ? countsByVendor.get(vendorId) : undefined;
      if (vendorId && !vendorCounts) {
        vendorCounts = { received: 0, approved: 0, applied: 0 };
        countsByVendor.set(vendorId, vendorCounts);
      }
      if (l.status === "received") {
        counts.received += 1;
        if (vendorCounts) vendorCounts.received += 1;
        newestReceivedAt = Math.max(newestReceivedAt, l.createdAt.getTime());
      } else if (l.status === "approved") {
        counts.approved += 1;
        if (vendorCounts) vendorCounts.approved += 1;
      } else if (l.status === "applied") {
        counts.applied += 1;
        if (vendorCounts) vendorCounts.applied += 1;
      }
    }

    const partHtsDigits =
      part.htsCode === null ? null : normalizeHts(part.htsCode);

    const sourceRows = sourcesByPartId.get(part.id) ?? [];
    const sourceByVendorId = new Map(sourceRows.map((s) => [s.vendorId, s]));
    const sources: PartSourceRow[] = sourceRows
      .map((s) => {
        const estimated = computeEstimatedLandedCost(
          {
            unitCostCents: centsOf(s.unitCost),
            htsDigits: partHtsDigits,
            countryOfOrigin: s.countryOfOrigin,
          },
          ref,
          asOf,
        );
        return {
          id: s.id,
          vendorId: s.vendorId,
          vendorName: s.vendor.name,
          countryOfOrigin: s.countryOfOrigin,
          unitCost: s.unitCost,
          estimatedPerUnitCents: estimated?.perUnitCents ?? null,
          estimateIncomplete: estimated?.incomplete ?? false,
          quoteCounts: countsByVendor.get(s.vendorId) ?? {
            received: 0,
            approved: 0,
            applied: 0,
          },
          usage: usage.get(`${part.id}:${s.vendorId}`) ?? {
            poCount: 0,
            invoiceCount: 0,
            entryCount: 0,
          },
        };
      })
      .sort((a, b) => a.vendorName.localeCompare(b.vendorName));

    const quotes: PartQuoteRow[] = sorted.map((l) => {
      const quoteCostCents = centsOf(l.unitCost) as number;
      const sheetVendorSource = l.quoteSheet.vendorId
        ? sourceByVendorId.get(l.quoteSheet.vendorId)
        : undefined;
      const estimated = computeEstimatedLandedCost(
        {
          unitCostCents: quoteCostCents,
          htsDigits: partHtsDigits,
          countryOfOrigin:
            l.countryOfOrigin ?? sheetVendorSource?.countryOfOrigin ?? null,
        },
        ref,
        asOf,
      );
      const vendorCostCents = centsOf(sheetVendorSource?.unitCost ?? null);
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
        vendorId: l.quoteSheet.vendorId,
        quoteDate: l.quoteSheet.quoteDate,
        documentId: l.quoteSheet.documentId,
        estimatedPerUnitCents: estimated?.perUnitCents ?? null,
        estimateIncomplete: estimated?.incomplete ?? false,
        deltaVsCurrentCents:
          vendorCostCents !== null && l.currency === "USD"
            ? quoteCostCents - vendorCostCents
            : null,
        newerReceivedExists:
          l.status === "approved" &&
          newestReceivedAt > l.createdAt.getTime(),
      };
    });

    const latest = latestByPartId.get(part.id);
    const pendingChanges = counts.approved > 0;

    const run = latestClassificationByPartId.get(part.id) ?? null;
    const classification: PartClassificationInfo | null =
      run === null
        ? null
        : {
            classifiedAt: run.createdAt.toISOString().slice(0, 10),
            classifier: run.classifier,
            outcome: run.outcome ?? "none",
            currentConfidence: (() => {
              const match = run.candidates.find(
                (c) => c.codeDigits === partHtsDigits,
              );
              return match?.confidence == null
                ? null
                : Number(match.confidence);
            })(),
            suggestions: run.candidates
              .filter((c) => c.codeDigits !== partHtsDigits)
              .map((c) => ({
                code: c.code,
                codeDigits: c.codeDigits,
                description: c.description,
                confidence: c.confidence === null ? null : Number(c.confidence),
                reason: c.reason,
                savingRate: candidateDutySavingRate(
                  {
                    candidateDigits: c.codeDigits,
                    currentDigits: partHtsDigits,
                    origins: sourceRows.map((s) => s.countryOfOrigin),
                    asOf,
                  },
                  ref,
                ),
              })),
          };

    return {
      ...part,
      sources,
      costRangeCents: rangeOf(sources.map((s) => centsOf(s.unitCost))),
      estimatedRangeCents: rangeOf(
        sources.map((s) => s.estimatedPerUnitCents),
      ),
      estimateIncomplete: sources.some((s) => s.estimateIncomplete),
      actualLatestPerUnitCents: latest?.perUnitCents ?? null,
      actualLatestEntryNumber: latest?.entryNumber ?? null,
      actualLatestEntryDate: latest?.entryDate ?? null,
      openReviewItemId: openItemByPartId.get(part.id)?.id ?? null,
      openReviewKind: openItemByPartId.get(part.id)?.kind ?? null,
      quoteCounts: counts,
      pendingChanges,
      hasUnapproved: counts.received > 0,
      displayStatus:
        part.status === "active" && pendingChanges
          ? "pending_changes"
          : part.status,
      quotes,
      classification,
    };
  });
}

/** Per-(part, vendor) activity counts, keyed `${partId}:${vendorId}`.
 *  Entries are reached two ways — entry↔invoice links and entry↔PO links —
 *  so distinct entry ids are merged in code rather than summed per path. */
async function fetchVendorUsage(
  orgId: string,
): Promise<Map<string, PartVendorUsage>> {
  const [poRows, invoiceRows, entryViaInvoice, entryViaPo] = await Promise.all([
    db
      .select({
        partId: schema.purchaseOrderLines.partId,
        vendorId: schema.purchaseOrders.vendorId,
        n: countDistinct(schema.purchaseOrderLines.purchaseOrderId),
      })
      .from(schema.purchaseOrderLines)
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.purchaseOrderLines.purchaseOrderId, schema.purchaseOrders.id),
      )
      .where(
        and(
          eq(schema.purchaseOrderLines.orgId, orgId),
          isNotNull(schema.purchaseOrderLines.partId),
          isNotNull(schema.purchaseOrders.vendorId),
        ),
      )
      .groupBy(schema.purchaseOrderLines.partId, schema.purchaseOrders.vendorId),
    db
      .select({
        partId: schema.invoiceLineItems.partId,
        vendorId: schema.invoices.vendorId,
        n: countDistinct(schema.invoiceLineItems.invoiceId),
      })
      .from(schema.invoiceLineItems)
      .innerJoin(
        schema.invoices,
        eq(schema.invoiceLineItems.invoiceId, schema.invoices.id),
      )
      .where(
        and(
          eq(schema.invoiceLineItems.orgId, orgId),
          isNotNull(schema.invoiceLineItems.partId),
          isNotNull(schema.invoices.vendorId),
        ),
      )
      .groupBy(schema.invoiceLineItems.partId, schema.invoices.vendorId),
    db
      .selectDistinct({
        partId: schema.invoiceLineItems.partId,
        vendorId: schema.invoices.vendorId,
        entryId: schema.entryInvoices.entryId,
      })
      .from(schema.entryInvoices)
      .innerJoin(
        schema.invoices,
        eq(schema.entryInvoices.invoiceId, schema.invoices.id),
      )
      .innerJoin(
        schema.invoiceLineItems,
        eq(schema.invoiceLineItems.invoiceId, schema.invoices.id),
      )
      .where(
        and(
          eq(schema.entryInvoices.orgId, orgId),
          isNotNull(schema.invoiceLineItems.partId),
          isNotNull(schema.invoices.vendorId),
        ),
      ),
    db
      .selectDistinct({
        partId: schema.purchaseOrderLines.partId,
        vendorId: schema.purchaseOrders.vendorId,
        entryId: schema.entryPurchaseOrders.entryId,
      })
      .from(schema.entryPurchaseOrders)
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.entryPurchaseOrders.purchaseOrderId, schema.purchaseOrders.id),
      )
      .innerJoin(
        schema.purchaseOrderLines,
        eq(schema.purchaseOrderLines.purchaseOrderId, schema.purchaseOrders.id),
      )
      .where(
        and(
          eq(schema.entryPurchaseOrders.orgId, orgId),
          isNotNull(schema.purchaseOrderLines.partId),
          isNotNull(schema.purchaseOrders.vendorId),
        ),
      ),
  ]);

  const byKey = new Map<string, PartVendorUsage>();
  const usageOf = (partId: string, vendorId: string): PartVendorUsage => {
    const key = `${partId}:${vendorId}`;
    let u = byKey.get(key);
    if (!u) {
      u = { poCount: 0, invoiceCount: 0, entryCount: 0 };
      byKey.set(key, u);
    }
    return u;
  };

  for (const r of poRows) {
    usageOf(r.partId as string, r.vendorId as string).poCount = r.n;
  }
  for (const r of invoiceRows) {
    usageOf(r.partId as string, r.vendorId as string).invoiceCount = r.n;
  }
  const entrySets = new Map<string, Set<string>>();
  for (const r of [...entryViaInvoice, ...entryViaPo]) {
    const key = `${r.partId as string}:${r.vendorId as string}`;
    const set = entrySets.get(key) ?? new Set<string>();
    set.add(r.entryId);
    entrySets.set(key, set);
  }
  for (const [key, set] of entrySets) {
    const [partId, vendorId] = key.split(":");
    usageOf(partId, vendorId).entryCount = set.size;
  }
  return byKey;
}

/** Entry lines (with charges) from filed entries, shaped for rollupBySku. */
async function fetchActualRollupLines(orgId: string): Promise<RollupLine[]> {
  const rows = await db.query.entryLineItems.findMany({
    where: eq(schema.entryLineItems.orgId, orgId),
    with: {
      charges: true,
      entry: {
        columns: { id: true, entryNumber: true, entryDate: true },
      },
    },
  });

  return rows
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
