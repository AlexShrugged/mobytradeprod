import "server-only";

import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { assembleEvents } from "@/lib/events/assemble";
import type {
  BusinessEvent,
  EventDocumentRef,
  EventType,
} from "@/lib/events/types";
import { deriveRefundStage } from "@/lib/refunds";
import { formatCents } from "@/lib/format";

// Materializes the derived events feed (see src/lib/events/types.ts). One
// source query per event family, each pushed down as far as practical, then
// merged by the pure assembler. partId narrows every source to one SKU — the
// same code serves the Events page and the Parts-row history.

const centsOf = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

type Scope = {
  partId: string | null;
  entryIds: string[] | null; // null = unscoped
  poIds: string[] | null;
  shipmentIds: string[] | null;
};

async function resolveScope(orgId: string, partId?: string): Promise<Scope> {
  if (!partId) {
    return { partId: null, entryIds: null, poIds: null, shipmentIds: null };
  }
  const [entryLines, poLines] = await Promise.all([
    db
      .select({ entryId: schema.entryLineItems.entryId })
      .from(schema.entryLineItems)
      .where(
        and(
          eq(schema.entryLineItems.orgId, orgId),
          eq(schema.entryLineItems.partId, partId),
        ),
      ),
    db
      .select({ poId: schema.purchaseOrderLines.purchaseOrderId })
      .from(schema.purchaseOrderLines)
      .where(
        and(
          eq(schema.purchaseOrderLines.orgId, orgId),
          eq(schema.purchaseOrderLines.partId, partId),
        ),
      ),
  ]);
  const poIds = [...new Set(poLines.map((r) => r.poId))];
  const shipmentRows = poIds.length
    ? await db
        .select({ shipmentId: schema.shipmentPurchaseOrders.shipmentId })
        .from(schema.shipmentPurchaseOrders)
        .where(inArray(schema.shipmentPurchaseOrders.purchaseOrderId, poIds))
    : [];
  return {
    partId,
    entryIds: [...new Set(entryLines.map((r) => r.entryId))],
    poIds,
    shipmentIds: [...new Set(shipmentRows.map((r) => r.shipmentId))],
  };
}

// ---------------------------------------------------------------- provenance

type LinkedEntityType = (typeof schema.linkedEntityType.enumValues)[number];

async function loadDocumentRefs(
  orgId: string,
  wanted: Map<LinkedEntityType, Set<string>>,
): Promise<Map<string, EventDocumentRef[]>> {
  const conditions = [...wanted.entries()]
    .filter(([, ids]) => ids.size > 0)
    .map(([entityType, ids]) =>
      and(
        eq(schema.documentLinks.entityType, entityType),
        inArray(schema.documentLinks.entityId, [...ids]),
      ),
    );
  if (conditions.length === 0) return new Map();
  const rows = await db
    .select({
      entityType: schema.documentLinks.entityType,
      entityId: schema.documentLinks.entityId,
      created: schema.documentLinks.created,
      docId: schema.documents.id,
      fileName: schema.documents.fileName,
      docType: schema.documents.docType,
      fileSize: schema.documents.fileSize,
    })
    .from(schema.documentLinks)
    .innerJoin(
      schema.documents,
      eq(schema.documentLinks.documentId, schema.documents.id),
    )
    .where(and(eq(schema.documentLinks.orgId, orgId), or(...conditions)));

  const byEntity = new Map<string, EventDocumentRef[]>();
  for (const r of rows) {
    const key = `${r.entityType}:${r.entityId}`;
    const list = byEntity.get(key) ?? [];
    list.push({
      id: r.docId,
      fileName: r.fileName,
      docType: r.docType,
      fileSize: r.fileSize,
      created: r.created,
    });
    byEntity.set(key, list);
  }
  // Creating documents first — they're the primary provenance.
  for (const list of byEntity.values()) {
    list.sort((a, b) => Number(b.created) - Number(a.created));
  }
  return byEntity;
}

function docProvenance(
  byEntity: Map<string, EventDocumentRef[]>,
  entityType: LinkedEntityType,
  entityId: string,
  fallback: BusinessEvent["provenance"],
): BusinessEvent["provenance"] {
  const docs = byEntity.get(`${entityType}:${entityId}`);
  return docs && docs.length > 0 ? { kind: "documents", documents: docs } : fallback;
}

// ---------------------------------------------------------------- sources

export async function getEvents(opts?: {
  types?: readonly EventType[] | null;
  partId?: string;
  limit?: number;
}): Promise<BusinessEvent[]> {
  const orgId = await getCurrentOrgId();
  const scope = await resolveScope(orgId, opts?.partId);

  // A scoped source with an empty id set contributes nothing (drizzle's
  // inArray rejects empty arrays, so guard before querying).
  const scoped = <T>(ids: string[] | null, run: () => Promise<T[]>) =>
    ids !== null && ids.length === 0 ? Promise.resolve([] as T[]) : run();

  const [
    entryRows,
    shipmentRows,
    poRows,
    refundRows,
    quoteSheetRows,
    quoteLineRows,
    partRows,
    fieldChangeRows,
    appliedRevisionRows,
  ] = await Promise.all([
    scoped(scope.entryIds, () =>
      db.query.entries.findMany({
        where: and(
          eq(schema.entries.orgId, orgId),
          isNotNull(schema.entries.entryDate),
          ...(scope.entryIds ? [inArray(schema.entries.id, scope.entryIds)] : []),
        ),
      }),
    ),
    scoped(scope.shipmentIds, () =>
      db.query.shipments.findMany({
        where: and(
          eq(schema.shipments.orgId, orgId),
          ...(scope.shipmentIds
            ? [inArray(schema.shipments.id, scope.shipmentIds)]
            : []),
        ),
      }),
    ),
    scoped(scope.poIds, () =>
      db.query.purchaseOrders.findMany({
        where: and(
          eq(schema.purchaseOrders.orgId, orgId),
          ...(scope.poIds
            ? [inArray(schema.purchaseOrders.id, scope.poIds)]
            : []),
        ),
      }),
    ),
    scoped(scope.entryIds, () =>
      db.query.refundClaims.findMany({
        where: and(
          eq(schema.refundClaims.orgId, orgId),
          ...(scope.entryIds
            ? [inArray(schema.refundClaims.entryId, scope.entryIds)]
            : []),
        ),
      }),
    ),
    // Quote sheets: scoped through their lines' partId below (fetch all,
    // filter after join rows load — sheets are few).
    db.query.quoteSheets.findMany({
      where: eq(schema.quoteSheets.orgId, orgId),
      with: { lines: { columns: { partId: true, sku: true } } },
    }),
    db.query.quoteLines.findMany({
      where: and(
        eq(schema.quoteLines.orgId, orgId),
        ...(scope.partId ? [eq(schema.quoteLines.partId, scope.partId)] : []),
      ),
      with: {
        quoteSheet: { columns: { id: true, supplierName: true, documentId: true } },
        part: { columns: { id: true, sku: true } },
      },
    }),
    db.query.parts.findMany({
      where: and(
        eq(schema.parts.orgId, orgId),
        ...(scope.partId ? [eq(schema.parts.id, scope.partId)] : []),
      ),
      columns: { id: true, sku: true, status: true, createdAt: true },
    }),
    db.query.fieldChanges.findMany({
      where: and(
        eq(schema.fieldChanges.orgId, orgId),
        eq(schema.fieldChanges.entityType, "part"),
        ...(scope.partId ? [eq(schema.fieldChanges.entityId, scope.partId)] : []),
      ),
      orderBy: desc(schema.fieldChanges.createdAt),
    }),
    // Tariff rate changes are global; hidden in part scope (a per-part
    // relevance filter is a later refinement).
    scope.partId
      ? Promise.resolve([])
      : db.query.measureRevisions.findMany({
          where: isNotNull(schema.measureRevisions.appliedAt),
          with: { appliedMeasure: true, announcement: true },
        }),
  ]);

  const filteredSheets = scope.partId
    ? quoteSheetRows.filter((s) =>
        s.lines.some((l) => l.partId === scope.partId),
      )
    : quoteSheetRows;

  const partById = new Map(partRows.map((p) => [p.id, p]));

  // Batch document provenance for everything that may carry documents.
  const wanted = new Map<LinkedEntityType, Set<string>>([
    ["entry", new Set(entryRows.map((e) => e.id))],
    ["shipment", new Set(shipmentRows.map((s) => s.id))],
    ["purchase_order", new Set(poRows.map((p) => p.id))],
    ["refund_claim", new Set(refundRows.map((r) => r.id))],
    ["quote_sheet", new Set(filteredSheets.map((q) => q.id))],
    ["part", new Set(partRows.map((p) => p.id))],
  ]);
  const docsByEntity = await loadDocumentRefs(orgId, wanted);

  const today = new Date().toISOString().slice(0, 10);
  const iso = (d: Date) => d.toISOString();

  const entryEvents: BusinessEvent[] = entryRows.map((e) => {
    const duties =
      (centsOf(e.totalDuty) ?? 0) +
      (centsOf(e.mpfAmount) ?? 0) +
      (centsOf(e.hmfAmount) ?? 0);
    return {
      id: `entry_filed:${e.id}`,
      type: "entry_filed",
      occurredOn: e.entryDate!,
      dateBasis: "exact",
      recordedAt: iso(e.createdAt),
      title: `Entry ${e.entryNumber} ${e.status === "draft" ? "created" : "filed"}`,
      detail:
        duties > 0
          ? `${formatCents(duties)} duties & fees at ${e.portOfEntry ?? "port"}`
          : undefined,
      amountCents: duties > 0 ? duties : null,
      amountTone: "duty",
      entityRefs: [
        { type: "entry", id: e.id, label: e.entryNumber, href: `/entries/${e.id}` },
      ],
      provenance: docProvenance(docsByEntity, "entry", e.id, { kind: "system" }),
    };
  });

  const shipmentEvents: BusinessEvent[] = [];
  for (const s of shipmentRows) {
    const sailed = s.sailedOnBoardDate ?? s.etd;
    if (sailed && sailed <= today) {
      shipmentEvents.push({
        id: `shipment_sailed:${s.id}`,
        type: "shipment_sailed",
        occurredOn: sailed,
        dateBasis: s.sailedOnBoardDate ? "exact" : "estimated",
        recordedAt: iso(s.createdAt),
        title: `Shipment ${s.shipmentNumber} sailed`,
        detail:
          s.originPort && s.destinationPort
            ? `${s.originPort} → ${s.destinationPort}${s.vessel ? ` on ${s.vessel}` : ""}`
            : undefined,
        entityRefs: [
          { type: "shipment", id: s.id, label: s.shipmentNumber },
        ],
        provenance: docProvenance(docsByEntity, "shipment", s.id, {
          kind: "system",
        }),
      });
    }
    const arrived =
      s.status === "arrived" || s.status === "delivered"
        ? (s.eta ?? null)
        : s.eta && s.eta <= today
          ? s.eta
          : null;
    if (arrived) {
      shipmentEvents.push({
        id: `shipment_arrived:${s.id}`,
        type: "shipment_arrived",
        occurredOn: arrived,
        dateBasis: "estimated",
        recordedAt: iso(s.updatedAt),
        title: `Shipment ${s.shipmentNumber} arrived`,
        detail: s.destinationPort ? `at ${s.destinationPort}` : undefined,
        entityRefs: [{ type: "shipment", id: s.id, label: s.shipmentNumber }],
        provenance: docProvenance(docsByEntity, "shipment", s.id, {
          kind: "system",
        }),
      });
    }
  }

  const poEvents: BusinessEvent[] = poRows.map((po) => ({
    id: `po_placed:${po.id}`,
    type: "po_placed",
    occurredOn: po.orderDate ?? po.createdAt.toISOString().slice(0, 10),
    dateBasis: po.orderDate ? "exact" : "recorded",
    recordedAt: iso(po.createdAt),
    // PO numbers already carry the "PO-" prefix — don't double it.
    title: `${po.poNumber} placed${po.supplierName ? ` with ${po.supplierName}` : ""}`,
    amountCents: centsOf(po.totalAmount),
    amountTone: "neutral",
    entityRefs: [{ type: "purchase_order", id: po.id, label: po.poNumber }],
    provenance: docProvenance(docsByEntity, "purchase_order", po.id, {
      kind: "system",
    }),
  }));

  const refundEvents: BusinessEvent[] = refundRows.map((r) => {
    const stage = deriveRefundStage(r.claimStatus, r.refundStatus);
    const amount =
      (centsOf(r.refundClassAmount) ?? 0) +
      (centsOf(r.refundInterestAmount) ?? 0);
    const stageTitles: Record<string, string> = {
      paid: "Refund paid",
      pending_payout: "Refund approved, payout pending",
      rejected: "Refund claim rejected",
      processing: "Refund claim update",
    };
    return {
      id: `refund_update:${r.id}`,
      type: "refund_update",
      occurredOn:
        r.refundDate ??
        r.liquidationDate ??
        r.createdAt.toISOString().slice(0, 10),
      dateBasis: r.refundDate ?? r.liquidationDate ? "exact" : "recorded",
      recordedAt: iso(r.updatedAt),
      title: `${stageTitles[stage]} — entry ${r.entrySummaryNumber}`,
      amountCents: amount,
      amountTone: "refund",
      entityRefs: [
        {
          type: "refund_claim",
          id: r.id,
          label: r.entrySummaryNumber,
          ...(r.entryId ? { href: `/entries/${r.entryId}` } : {}),
        },
      ],
      provenance: docProvenance(docsByEntity, "refund_claim", r.id, {
        kind: "system",
      }),
    };
  });

  const quoteSheetEvents: BusinessEvent[] = filteredSheets.map((q) => ({
    id: `quote_received:${q.id}`,
    type: "quote_received",
    occurredOn: q.quoteDate ?? q.createdAt.toISOString().slice(0, 10),
    dateBasis: q.quoteDate ? "exact" : "recorded",
    recordedAt: iso(q.createdAt),
    title: `Quote sheet received${q.supplierName ? ` from ${q.supplierName}` : ""}`,
    detail: `${q.lines.length} SKU${q.lines.length === 1 ? "" : "s"}: ${q.lines
      .map((l) => l.sku)
      .join(", ")}`,
    entityRefs: [
      {
        type: "quote_sheet",
        id: q.id,
        label: q.supplierName ?? "Quote sheet",
      },
    ],
    provenance: docProvenance(
      docsByEntity,
      "quote_sheet",
      q.id,
      { kind: "user", actor: null, at: iso(q.createdAt) },
    ),
  }));

  const quoteLineEvents: BusinessEvent[] = [];
  for (const l of quoteLineRows) {
    if (l.decidedAt && (l.status === "approved" || l.status === "applied")) {
      quoteLineEvents.push({
        id: `quote_approved:${l.id}`,
        type: "quote_approved",
        occurredOn: l.decidedAt.toISOString().slice(0, 10),
        dateBasis: "exact",
        recordedAt: iso(l.decidedAt),
        title: `Quote approved for ${l.part.sku} at ${formatCents(centsOf(l.unitCost))}/unit`,
        detail: l.quoteSheet.supplierName
          ? `from ${l.quoteSheet.supplierName}`
          : undefined,
        entityRefs: [
          {
            type: "part",
            id: l.partId,
            label: l.part.sku,
            href: `/parts?expand=${l.partId}`,
          },
        ],
        provenance: { kind: "user", actor: l.decidedBy, at: iso(l.decidedAt) },
      });
    }
    if (l.appliedAt && l.status === "applied") {
      quoteLineEvents.push({
        id: `quote_applied:${l.id}`,
        type: "quote_applied",
        occurredOn: l.appliedAt.toISOString().slice(0, 10),
        dateBasis: "exact",
        recordedAt: iso(l.appliedAt),
        title: `New cost official on ${l.part.sku} — ${formatCents(centsOf(l.unitCost))}/unit`,
        detail: l.appliedPoLineId
          ? "confirmed by matching PO"
          : "finalized new SKU",
        entityRefs: [
          {
            type: "part",
            id: l.partId,
            label: l.part.sku,
            href: `/parts?expand=${l.partId}`,
          },
        ],
        provenance: docProvenance(
          docsByEntity,
          "quote_sheet",
          l.quoteSheetId,
          { kind: "system" },
        ),
      });
    }
  }

  const partEvents: BusinessEvent[] = partRows.map((p) => ({
    id: `part_created:${p.id}`,
    type: "part_created",
    occurredOn: p.createdAt.toISOString().slice(0, 10),
    dateBasis: "exact",
    recordedAt: iso(p.createdAt),
    title: `SKU ${p.sku} created${p.status === "draft" ? " (draft — pending quote approval)" : ""}`,
    entityRefs: [
      { type: "part", id: p.id, label: p.sku, href: `/parts?expand=${p.id}` },
    ],
    provenance: docProvenance(docsByEntity, "part", p.id, { kind: "system" }),
  }));

  const COST_FIELDS = new Set(["unit_cost", "unitCost", "country_of_origin", "countryOfOrigin", "manufacturer", "name", "description"]);
  const fieldChangeEvents: BusinessEvent[] = [];
  for (const fc of fieldChangeRows) {
    const isHts = fc.field === "hts_code" || fc.field === "htsCode";
    if (!isHts && !COST_FIELDS.has(fc.field)) continue;
    const part = partById.get(fc.entityId);
    const sku = part?.sku ?? "unknown SKU";
    fieldChangeEvents.push({
      id: `${isHts ? "hts_changed" : "cost_changed"}:${fc.id}`,
      type: isHts ? "hts_changed" : "cost_changed",
      occurredOn: fc.createdAt.toISOString().slice(0, 10),
      dateBasis: "exact",
      recordedAt: iso(fc.createdAt),
      title: isHts
        ? `HTS code changed on ${sku}`
        : `${fc.field.replace(/_/g, " ")} changed on ${sku}`,
      delta: { field: fc.field, from: fc.oldValue, to: fc.newValue },
      entityRefs: [
        {
          type: "part",
          id: fc.entityId,
          label: sku,
          href: `/parts?expand=${fc.entityId}`,
        },
      ],
      provenance: fc.actor
        ? { kind: "user", actor: fc.actor, at: iso(fc.createdAt) }
        : { kind: "system", note: fc.source },
    });
  }

  const tariffEvents: BusinessEvent[] = appliedRevisionRows.flatMap((rev) => {
    if (!rev.appliedMeasure) return [];
    return [
      {
        id: `tariff_rate_change:${rev.id}`,
        type: "tariff_rate_change" as const,
        occurredOn: rev.appliedMeasure.effectiveDate,
        dateBasis: "exact" as const,
        recordedAt: iso(rev.appliedAt!),
        title: `Tariff update applied: ${rev.appliedMeasure.name}`,
        detail: rev.announcement?.title,
        entityRefs: [
          {
            type: "measure" as const,
            id: rev.appliedMeasure.id,
            label: rev.appliedMeasure.name,
          },
        ],
        provenance: { kind: "system" as const, note: rev.announcement?.sourceRef },
      },
    ];
  });

  return assembleEvents(
    [
      entryEvents,
      shipmentEvents,
      poEvents,
      refundEvents,
      quoteSheetEvents,
      quoteLineEvents,
      partEvents,
      fieldChangeEvents,
      tariffEvents,
    ],
    { types: opts?.types ?? null, limit: opts?.limit },
  );
}
