// The derived events feed. Events are NEVER stored — every event is a
// projection of a domain row (entries, shipments, POs, quotes, refund claims,
// field_changes, applied measure revisions), so a corrected occurrence date
// (e.g. a reprocessed BOL fixing a sail date) moves the event automatically.
// queries/events.ts materializes per-source rows; assemble.ts merges them.

export type EventType =
  | "po_placed"
  | "shipment_sailed"
  | "shipment_arrived"
  | "entry_filed"
  | "invoice_received"
  | "refund_update"
  | "quote_received"
  | "quote_approved"
  | "quote_applied"
  | "part_created"
  | "hts_changed"
  | "cost_changed"
  | "tariff_rate_change";

// How the occurrence date was resolved: the business date itself ("exact"),
// an estimate standing in for it (ETA/ETD — "estimated"), or the moment we
// recorded the row because no business date exists ("recorded"). Mirrors the
// sail-basis idiom; estimated/recorded render muted in the UI.
export type DateBasis = "exact" | "estimated" | "recorded";

export type EventEntityRef = {
  type:
    | "entry"
    | "shipment"
    | "purchase_order"
    | "invoice"
    | "part"
    | "quote_sheet"
    | "refund_claim"
    | "measure";
  id: string;
  label: string;
  /** Set when the entity has a page to link to. */
  href?: string;
};

export type EventDocumentRef = {
  id: string;
  fileName: string;
  docType: string;
  fileSize: number;
  /** This document created the underlying record (vs references it). */
  created: boolean;
};

export type EventProvenance =
  | { kind: "documents"; documents: EventDocumentRef[] }
  | { kind: "user"; actor: string | null; at: string }
  | { kind: "system"; note?: string };

export type BusinessEvent = {
  /** Stable: `${type}:${sourceRowId}` — safe as a React key. */
  id: string;
  type: EventType;
  /** ISO date (day grain) the event actually occurred — the sort key. */
  occurredOn: string;
  dateBasis: DateBasis;
  /** When the row landed in the system; sort tiebreaker and the
   *  occurred≠recorded display. */
  recordedAt: string;
  title: string;
  detail?: string;
  /** Money attached to the event (duties, PO total, quote cost delta). */
  amountCents?: number | null;
  amountTone?: "duty" | "refund" | "neutral";
  /** Field-level change payload for hts_changed / cost_changed. */
  delta?: { field: string; from: string | null; to: string | null };
  entityRefs: EventEntityRef[];
  provenance: EventProvenance;
};

// Chip groups on the Events page. tariff_rate_change is visible under "All"
// and "Classification" (rate context lives next to code review).
export const EVENT_FILTER_GROUPS = {
  entries: ["entry_filed"],
  shipments: ["shipment_sailed", "shipment_arrived"],
  pos: ["po_placed"],
  invoices: ["invoice_received"],
  quotes: ["quote_received", "quote_approved", "quote_applied"],
  classification: ["hts_changed", "tariff_rate_change"],
  refunds: ["refund_update"],
  edits: ["cost_changed", "part_created"],
} as const satisfies Record<string, readonly EventType[]>;

export type EventFilterGroup = keyof typeof EVENT_FILTER_GROUPS;

export function typesForGroup(
  group: EventFilterGroup | null,
): readonly EventType[] | null {
  if (!group) return null;
  return EVENT_FILTER_GROUPS[group] ?? null;
}
