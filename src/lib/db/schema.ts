// MobyTrade schema. Carried from mobynew with these deltas:
//   - kits/kit_parts dropped (unused by customers)
//   - parts: + manufacturer, boolean `active` replaced by status draft|active|archived
//   - net-new: quote_sheets/quote_lines (quotes absorbed into parts),
//     purchase_order_lines (quote→PO matching + SKU history),
//     integration_sources (Data page intake channels)
//   - hts_codes: base-schedule columns (hierarchy, raw rate texts, release) and
//     per-code change-tiling windows (valid_from/valid_to) so historical entries
//     audit against the base rates of their day
//   - documents: + source_id (which intake channel delivered it)
//
// Doctrines (see CLAUDE.md): derived data is never stored; single writer per
// projection; reference tables are global (no org_id) and never LLM-written.

import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

const id = () => uuid("id").primaryKey().$defaultFn(uuidv7);
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

// ---------------------------------------------------------------- enums

export const entryStatus = pgEnum("entry_status", [
  "draft",
  "filed",
  "released",
  "liquidated",
]);
export const shipmentStatus = pgEnum("shipment_status", [
  "booked",
  "in_transit",
  "arrived",
  "delivered",
]);
export const shipmentMode = pgEnum("shipment_mode", [
  "ocean",
  "air",
  "truck",
  "rail",
]);
export const poStatus = pgEnum("po_status", [
  "open",
  "partially_received",
  "received",
  "closed",
]);
export const documentType = pgEnum("document_type", [
  "port_entry",
  "shipment",
  "purchase_order",
  "commercial_invoice",
  "packing_list",
  "quote_sheet",
  "refund_report",
  "other",
]);
export const documentStatus = pgEnum("document_status", [
  "pending",
  "processing",
  "processed",
  "failed",
]);
export const linkedEntityType = pgEnum("linked_entity_type", [
  "entry",
  "shipment",
  "purchase_order",
  "refund_claim",
  "invoice",
  "quote_sheet",
  "part",
]);
export const chargeType = pgEnum("charge_type", [
  "base_duty",
  "additional_duty",
  "mpf",
  "hmf",
  "antidumping",
  "countervailing",
  "other_fee",
]);
export const measureAuthority = pgEnum("measure_authority", [
  "section_301",
  "section_232_steel",
  "section_232_aluminum",
  "ieepa",
  "reciprocal",
  "section_122",
  // Catch-all for authorities the sync differ can't classify; the specifics
  // live in the measure's name/notes until a dedicated value is added.
  "other",
]);
export const measureScope = pgEnum("measure_scope", [
  "hts_list",
  "all_products",
]);
export const htsRateType = pgEnum("hts_rate_type", [
  "free",
  "ad_valorem",
  "specific",
  "compound",
  "other",
]);
export const auditAlertType = pgEnum("audit_alert_type", [
  "missing_measure",
  "unexpected_measure",
  "rate_mismatch",
  "amount_mismatch",
  "hts_discrepancy",
  "value_mismatch",
  "data_unreconciled",
  // Sail-conditioned expectations were computed from an estimated (ETD
  // fallback) or assumed (no date at all) sail date.
  "sail_date_assumption",
]);
export const auditSeverity = pgEnum("audit_severity", [
  "error",
  "warning",
  "info",
]);
export const auditAlertStatus = pgEnum("audit_alert_status", [
  "open",
  "resolved",
  "dismissed",
]);
// "processing" is reserved for an async classifier; the stub completes inline.
export const htsClassificationStatus = pgEnum("hts_classification_status", [
  "processing",
  "completed",
  "failed",
]);
export const htsClassificationOutcome = pgEnum("hts_classification_outcome", [
  "certain",
  "ambiguous",
  "none",
]);
// The ONE generic review-queue pattern: every human-gated change type joins
// this enum rather than growing its own queue.
export const reviewItemType = pgEnum("review_item_type", [
  "hts_classification",
  "tariff_measure_revision",
]);
export const reviewItemStatus = pgEnum("review_item_status", [
  "pending",
  "approved",
  "rejected",
  "superseded",
]);
export const reviewAction = pgEnum("review_action", [
  "accept",
  "reject",
  "acknowledge",
  "manual",
]);
export const partHtsReviewStatus = pgEnum("part_hts_review_status", [
  "pending",
  "confirmed",
  "accepted",
  "rejected",
  "acknowledged",
]);
// draft = created from an unapproved quote (or unfinished "New SKU") — its
// data never drives audit findings; archived replaces deletion.
export const partStatus = pgEnum("part_status", [
  "draft",
  "active",
  "archived",
]);
// received → approved → applied is the happy path; superseded happens when a
// newer quote for the same (part, supplier) arrives while still un-approved.
// Approved lines are NEVER auto-superseded — human decisions survive
// machine re-ingestion.
export const quoteLineStatus = pgEnum("quote_line_status", [
  "received",
  "approved",
  "rejected",
  "superseded",
  "applied",
]);
export const integrationKind = pgEnum("integration_kind", [
  "manual_upload",
  "sftp",
  "email_inbox",
  "erp",
]);
export const integrationStatus = pgEnum("integration_status", [
  "active",
  "paused",
  "error",
  "not_configured",
]);
export const announcementSource = pgEnum("announcement_source", [
  "usitc_hts",
  "federal_register",
  "manual",
]);
// resolved = every staged revision reached a terminal state (applied,
// rejected, or superseded); dismissed = a human closed it as irrelevant.
export const announcementStatus = pgEnum("announcement_status", [
  "open",
  "resolved",
  "dismissed",
]);
export const revisionChangeType = pgEnum("revision_change_type", [
  "create_measure",
  "rate_change",
  "scope_change",
  "end_measure",
  "stacking_change",
  "note_change",
]);

// ---------------------------------------------------------------- tenancy

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  importerOfRecord: text("importer_of_record"),
  // The purpose-built document intake address shown on the Data page.
  inboxAddress: text("inbox_address"),
  ...timestamps,
});

const orgId = () =>
  uuid("org_id")
    .notNull()
    .references(() => orgs.id);

// ---------------------------------------------------------------- event domain
//
// Entries, shipments, and purchase orders relate many-to-many in every
// direction. Line-level customs detail lives in entry_line_items /
// entry_line_charges below; the header totals here are kept in sync by the
// ingestion linker. "Future entries" (a shipment with no entry yet) are a
// derived projection — never rows here.

export const entries = pgTable(
  "entries",
  {
    id: id(),
    orgId: orgId(),
    entryNumber: varchar("entry_number", { length: 32 }).notNull(),
    entryDate: date("entry_date"),
    portOfEntry: varchar("port_of_entry", { length: 64 }),
    entryType: varchar("entry_type", { length: 16 }),
    importerOfRecord: text("importer_of_record"),
    status: entryStatus("status").notNull().default("draft"),
    totalEnteredValue: numeric("total_entered_value", { precision: 14, scale: 2 }),
    // totalDuty = all duty-type charges (base + additional + AD/CVD),
    // excluding MPF/HMF/fees. totalBaseDuty is the base-only slice.
    // "Duties & fees" is always derived in queries, never stored.
    totalDuty: numeric("total_duty", { precision: 12, scale: 2 }),
    totalBaseDuty: numeric("total_base_duty", { precision: 12, scale: 2 }),
    // MPF/HMF are ingested from documents, never computed — CBP applies
    // per-entry minimums and caps that make line-level math wrong.
    mpfAmount: numeric("mpf_amount", { precision: 10, scale: 2 }),
    hmfAmount: numeric("hmf_amount", { precision: 10, scale: 2 }),
    // Sum of linked refund claims (class + interest), synced by the linker.
    totalRefund: numeric("total_refund", { precision: 12, scale: 2 }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("entries_org_number_uq").on(t.orgId, t.entryNumber),
    index("entries_org_idx").on(t.orgId),
  ],
);

export const shipments = pgTable(
  "shipments",
  {
    id: id(),
    orgId: orgId(),
    shipmentNumber: varchar("shipment_number", { length: 32 }).notNull(),
    billOfLading: varchar("bill_of_lading", { length: 32 }),
    containerNumber: varchar("container_number", { length: 16 }),
    carrier: text("carrier"),
    vessel: text("vessel"),
    mode: shipmentMode("mode").notNull().default("ocean"),
    originPort: text("origin_port"),
    destinationPort: text("destination_port"),
    etd: date("etd"),
    eta: date("eta"),
    // The BOL's shipped-on-board notation date — the legally relevant
    // "laden" date for sail-conditioned tariff measures. ETD is the
    // estimate; this is the fact. Sail resolution falls back to ETD (flagged
    // "estimated") when this is null.
    sailedOnBoardDate: date("sailed_on_board_date"),
    status: shipmentStatus("status").notNull().default("booked"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("shipments_org_number_uq").on(t.orgId, t.shipmentNumber),
    index("shipments_org_idx").on(t.orgId),
  ],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    orgId: orgId(),
    poNumber: varchar("po_number", { length: 32 }).notNull(),
    supplierName: text("supplier_name"),
    orderDate: date("order_date"),
    expectedDate: date("expected_date"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }),
    status: poStatus("status").notNull().default("open"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pos_org_number_uq").on(t.orgId, t.poNumber),
    index("pos_org_idx").on(t.orgId),
  ],
);

// PO line items — the grain that quote→PO matching, per-SKU event history,
// and future-entry duty estimates all need. Written by the linker, wholesale
// delete+reinsert on document reprocess (same pattern as entry lines).
export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: id(),
    orgId: orgId(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    partId: uuid("part_id").references(() => parts.id, {
      onDelete: "set null",
    }),
    sku: varchar("sku", { length: 64 }),
    description: text("description"),
    quantity: numeric("quantity", { precision: 15, scale: 4 }),
    unitPrice: numeric("unit_price", { precision: 12, scale: 4 }),
    totalPrice: numeric("total_price", { precision: 12, scale: 2 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pol_po_line_uq").on(t.purchaseOrderId, t.lineNumber),
    index("pol_org_idx").on(t.orgId),
    index("pol_part_idx").on(t.partId),
  ],
);

// Join tables carry org_id so future tenant filtering / RLS never has to
// traverse to a parent row.

export const entryShipments = pgTable(
  "entry_shipments",
  {
    orgId: orgId(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.shipmentId] }),
    index("es_shipment_idx").on(t.shipmentId),
  ],
);

export const entryPurchaseOrders = pgTable(
  "entry_purchase_orders",
  {
    orgId: orgId(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.purchaseOrderId] }),
    index("epo_po_idx").on(t.purchaseOrderId),
  ],
);

// Entry↔shipment plus entry↔PO alone cannot answer "which POs rode on which
// shipment under this entry" — per-shipment duty allocation needs it, and the
// future-entry projection bundles a shipment's POs through it.
export const shipmentPurchaseOrders = pgTable(
  "shipment_purchase_orders",
  {
    orgId: orgId(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shipmentId, t.purchaseOrderId] }),
    index("spo_po_idx").on(t.purchaseOrderId),
  ],
);

// ---------------------------------------------------------------- documents

export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: orgId(),
    fileName: text("file_name").notNull(),
    fileSize: integer("file_size").notNull(),
    mimeType: text("mime_type").notNull(),
    storageKey: text("storage_key").notNull(),
    docType: documentType("doc_type").notNull().default("other"),
    status: documentStatus("status").notNull().default("pending"),
    // Which intake channel delivered this document (manual upload row, SFTP
    // source, email inbox, ERP connector). Null on legacy/unknown rows.
    sourceId: uuid("source_id").references(() => integrationSources.id, {
      onDelete: "set null",
    }),
    extractedData: jsonb("extracted_data"),
    // Full provider payloads (parse chunks, classification, cited extract) —
    // everything the provider returned, not just what maps into extracted_data.
    // Excluded from list queries; can be multiple MB per document. Retained
    // for provenance and future AI over the unstructured corpus.
    rawExtraction: jsonb("raw_extraction"),
    // Provider parse job id: opens in Reducto Studio, and can be re-extracted
    // via jobid:// within the provider's retention window.
    parseJobId: text("parse_job_id"),
    // Which processor produced extracted_data: "stub" | "reducto".
    processedBy: text("processed_by"),
    errorMessage: text("error_message"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("documents_org_idx").on(t.orgId),
    index("documents_status_idx").on(t.orgId, t.status),
    index("documents_source_idx").on(t.sourceId),
  ],
);

// Polymorphic link from a document to the domain record(s) it produced or
// attached to. entity_id intentionally has no FK; the app enforces validity.
// `created` distinguishes "this doc created the record" from "references it".
export const documentLinks = pgTable(
  "document_links",
  {
    orgId: orgId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    entityType: linkedEntityType("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    created: boolean("created").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.entityType, t.entityId] }),
    index("dl_entity_idx").on(t.entityType, t.entityId),
  ],
);

// ---------------------------------------------------------------- catalog

export const parts = pgTable(
  "parts",
  {
    id: id(),
    orgId: orgId(),
    sku: varchar("sku", { length: 64 }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    manufacturer: text("manufacturer"),
    unitOfMeasure: varchar("unit_of_measure", { length: 16 })
      .notNull()
      .default("EA"),
    // The OFFICIAL cost — written by manual edit or by quotes/service.ts when
    // an approved quote's PO confirms it. Draft parts carry the quote's cost
    // (draft means "not official" — that is the guard).
    unitCost: numeric("unit_cost", { precision: 10, scale: 4 }),
    countryOfOrigin: varchar("country_of_origin", { length: 2 }),
    htsCode: varchar("hts_code", { length: 12 }),
    // HTS review projection. The review queue + classifications are the
    // source of truth; these columns exist so parts surfaces can filter and
    // badge without a polymorphic join. Written only by
    // classification/service.ts, in the same transaction as the queue.
    // A provisional code was auto-selected by a classifier and not yet
    // human-committed — it must never drive audit findings.
    htsCodeProvisional: boolean("hts_code_provisional").notNull().default(false),
    htsReviewStatus: partHtsReviewStatus("hts_review_status"),
    // "Pending changes" (approved quote awaiting its PO) and "quote received"
    // are DERIVED from quote_lines, never stored here.
    status: partStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("parts_org_sku_uq").on(t.orgId, t.sku),
    index("parts_org_idx").on(t.orgId),
  ],
);

// ---------------------------------------------------------------- quotes
//
// A quote sheet is a supplier document quoting one or more SKUs; each quoted
// SKU is a quote_line — THE unit shown under a part on the Parts page.
// Sole writer: quotes/service.ts (draft-part creation, approval, PO
// application) — the linker delegates into it in-transaction.

export const quoteSheets = pgTable(
  "quote_sheets",
  {
    id: id(),
    orgId: orgId(),
    // Null = quote entered manually in the UI (New SKU / add-quote form);
    // provenance is then the actor on the quote_received event.
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    supplierName: text("supplier_name"),
    // The document's own date — the occurrence date for the events feed.
    // Null falls back to uploadedAt/createdAt, flagged "recorded".
    quoteDate: date("quote_date"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    validUntil: date("valid_until"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("quote_sheets_org_idx").on(t.orgId),
    index("quote_sheets_document_idx").on(t.documentId),
  ],
);

export const quoteLines = pgTable(
  "quote_lines",
  {
    id: id(),
    orgId: orgId(),
    quoteSheetId: uuid("quote_sheet_id")
      .notNull()
      .references(() => quoteSheets.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    // Always resolved: an unknown SKU auto-creates a draft part first.
    partId: uuid("part_id")
      .notNull()
      .references(() => parts.id, { onDelete: "cascade" }),
    // Provenance: this line created its (draft) part.
    partCreated: boolean("part_created").notNull().default(false),
    sku: varchar("sku", { length: 64 }).notNull(), // as printed on the sheet
    description: text("description"),
    unitCost: numeric("unit_cost", { precision: 10, scale: 4 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    // Supplier's claims — display and estimate inputs only, NEVER audit/money
    // drivers. A supplier-suggested HTS routes through classification.
    countryOfOrigin: varchar("country_of_origin", { length: 2 }),
    htsCode: varchar("hts_code", { length: 12 }),
    moq: numeric("moq", { precision: 15, scale: 4 }),
    leadTimeDays: integer("lead_time_days"),
    unitOfMeasure: varchar("unit_of_measure", { length: 16 }),
    status: quoteLineStatus("status").notNull().default("received"),
    decidedBy: text("decided_by"), // free text until auth lands
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    // The PO line whose arrival made this quote official. Null on applied
    // lines that finalized a draft part (no prior official state to confirm).
    appliedPoLineId: uuid("applied_po_line_id").references(
      () => purchaseOrderLines.id,
      { onDelete: "set null" },
    ),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("quote_lines_sheet_line_uq").on(t.quoteSheetId, t.lineNumber),
    index("quote_lines_part_status_idx").on(t.orgId, t.partId, t.status),
    index("quote_lines_sheet_idx").on(t.quoteSheetId),
  ],
);

// ---------------------------------------------------------------- integrations
//
// Intake channels shown on the Data page. One table with a per-kind config
// union (validated by zod in the routes) instead of a table per channel —
// the legacy platform's per-channel tables each accreted the same
// status/telemetry columns. No secrets in config; real connectors will add
// secret references later. last_* fields are operational telemetry (same
// category as documents.status), not derived business data.

export const integrationSources = pgTable(
  "integration_sources",
  {
    id: id(),
    orgId: orgId(),
    kind: integrationKind("kind").notNull(),
    name: text("name").notNull(),
    status: integrationStatus("status").notNull().default("not_configured"),
    config: jsonb("config").notNull().default({}),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("integration_sources_org_kind_name_uq").on(t.orgId, t.kind, t.name)],
);

// ---------------------------------------------------------------- tariff reference
//
// Reference tables are global (no org_id): they mirror objective government
// data — the HTS schedule, Chapter 99 trade measures, and stacking orders.
// They change only through seeds and the human-gated tariff sync
// (tariff-sync/apply.ts for Chapter 99, tariff-sync/base-apply.ts for the
// base schedule), never through document extraction, and no LLM output ever
// lands here.

export const tradeMeasures = pgTable(
  "trade_measures",
  {
    id: id(),
    name: text("name").notNull(),
    authority: measureAuthority("authority").notNull(),
    scope: measureScope("scope").notNull().default("hts_list"),
    // Countries of origin the measure applies to; null = every country.
    countries: varchar("countries", { length: 2 }).array(),
    effectiveDate: date("effective_date").notNull(),
    endDate: date("end_date"),
    // Sail-date conditions, tested against a shipment's laden date
    // (sailed_on_board_date, ETD fallback) — how on-the-water savings
    // clauses are expressed: effective/end dates gate on the ENTRY date,
    // these gate on the SAIL date, and one row can constrain both ("laden
    // before Feb 24 AND entered by Feb 28"). Null = no sail condition.
    sailedOnOrAfter: date("sailed_on_or_after"),
    sailedOnOrBefore: date("sailed_on_or_before"),
    // Window lineage: the measure row this one succeeded when an applied
    // revision re-rated or re-scoped the same Chapter 99 code.
    predecessorId: uuid("predecessor_id").references(
      (): AnyPgColumn => tradeMeasures.id,
    ),
    // When true, an applicable measure replaces (zeroes) the base duty.
    inLieuOfBaseDuty: boolean("in_lieu_of_base_duty").notNull().default(false),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("trade_measures_authority_idx").on(t.authority)],
);

// Chapter 99 measure lines may carry several rows per code, one per
// trade-measure window (a rate change closes the old measure at eff−1 and
// inserts a successor with its own row here); the measure's entry/sail
// windows disambiguate, and the apply planner enforces that windows never
// overlap. Base-schedule rows (chapters 1–97, trade_measure_id null) use
// per-code CHANGE-TILING instead: one open-ended window (valid_to null) per
// code in the common case, and when a release changes a code's rate or
// description, base-apply closes the current window at releaseEffective−1
// and inserts a successor — so historical entries audit against the base
// rates of their day. Codes absent from a new release get their window
// closed (absence == removal; USITC has no change feed). Rows match on
// normalized digits (code_digits); measure applicability is prefix-based via
// trade_measure_hts, which survives a partially seeded schedule.
export const htsCodes = pgTable(
  "hts_codes",
  {
    id: id(),
    code: varchar("code", { length: 15 }).notNull(), // dotted display form
    codeDigits: varchar("code_digits", { length: 10 }).notNull(),
    description: text("description").notNull(),
    chapter: integer("chapter").notNull(), // 99 = measure line
    rateType: htsRateType("rate_type").notNull().default("ad_valorem"),
    // Decimal fraction (0.25 = 25%); 0 for free. Null for specific/compound
    // rates, which v1 displays via col1_general but does not compute.
    rate: numeric("rate", { precision: 10, scale: 6 }),
    col1General: text("col1_general"), // raw display string ("2.8%", "Free")
    col1Special: text("col1_special"), // raw FTA parenthetical text
    col2Rate: text("col2_rate"),
    unitOfQuantity: text("unit_of_quantity"),
    // --- base-schedule hierarchy (null on Chapter 99 measure lines) ---
    indent: integer("indent"), // USITC indent level
    // Nearest coded ancestor in the indent tree (digits form).
    parentDigits: varchar("parent_digits", { length: 10 }),
    // When this row's own rate cells were blank, the digits of the
    // rate-bearing ancestor the rate was inherited from (USITC states rates
    // once on the subheading; 10-digit stat suffixes are blank).
    rateInheritedFrom: varchar("rate_inherited_from", { length: 10 }),
    // USITC release that last confirmed this row ("2026HTSRev9").
    release: text("release"),
    // Base-row change-tiling window; null valid_to = current. Chapter 99
    // rows leave both null (measure windows govern).
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    // Non-null marks this row as a Chapter 99 measure line. A measure's rate
    // always lives on its hts_codes row, never on trade_measures.
    tradeMeasureId: uuid("trade_measure_id").references(() => tradeMeasures.id),
    exemption: boolean("exemption").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("hts_codes_digits_measure_uq").on(t.codeDigits, t.tradeMeasureId),
    // One CURRENT base-schedule row per code; closed windows are history.
    uniqueIndex("hts_codes_digits_base_current_uq")
      .on(t.codeDigits)
      .where(sql`${t.tradeMeasureId} is null and ${t.validTo} is null`),
    index("hts_codes_measure_idx").on(t.tradeMeasureId),
    index("hts_codes_digits_idx").on(t.codeDigits),
  ],
);

// Digits-only HTS prefixes a measure covers. Inclusion only — exclusions are
// exemption=true Chapter 99 rows under the same measure.
export const tradeMeasureHts = pgTable(
  "trade_measure_hts",
  {
    tradeMeasureId: uuid("trade_measure_id")
      .notNull()
      .references(() => tradeMeasures.id, { onDelete: "cascade" }),
    htsPrefix: varchar("hts_prefix", { length: 10 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tradeMeasureId, t.htsPrefix] }),
    index("tmh_prefix_idx").on(t.htsPrefix),
  ],
);

// Authority-level "winner suppresses loser" orders (e.g. Section 232
// aluminum articles are exempt from reciprocal tariffs).
export const stackingRules = pgTable(
  "stacking_rules",
  {
    id: id(),
    winnerAuthority: measureAuthority("winner_authority").notNull(),
    loserAuthority: measureAuthority("loser_authority").notNull(),
    // Rendered verbatim in audit alerts — keep it a full sentence.
    reason: text("reason").notNull(),
    effectiveDate: date("effective_date").notNull(),
    endDate: date("end_date"),
    sourceRef: text("source_ref"),
    ...timestamps,
  },
  (t) => [
    // A pair may version over time; the apply planner closes the prior
    // window at eff−1 so windows for one pair never overlap.
    uniqueIndex("stacking_rules_pair_eff_uq").on(
      t.winnerAuthority,
      t.loserAuthority,
      t.effectiveDate,
    ),
  ],
);

// A fetched (or hand-entered) tariff announcement: a USITC HTS release, a
// Federal Register notice, or a manual entry. Global like the reference
// tables it stages changes for. The raw payload lives in the FileStore
// under raw_storage_key, not in a documents row — documents are org-scoped
// ingestion artifacts with a processing lifecycle.
export const tariffAnnouncements = pgTable(
  "tariff_announcements",
  {
    id: id(),
    source: announcementSource("source").notNull(),
    // Release id ("2026HTSRev9"), FR document number, or "<release>-base"
    // for a base-schedule refresh — the dedupe key.
    sourceRef: text("source_ref").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    publishedDate: date("published_date"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    rawStorageKey: text("raw_storage_key"),
    summary: text("summary"),
    status: announcementStatus("status").notNull().default("open"),
    ...timestamps,
  },
  (t) => [uniqueIndex("tariff_announcements_source_ref_uq").on(t.source, t.sourceRef)],
);

// Staged measure changes an announcement implies — the payload behind a
// review_items row (item_type "tariff_measure_revision", subject_id = this
// row's id), mirroring how hts_classifications backs classification review.
// Review status lives on the queue item; applied_at marks the moment the
// apply planner wrote reference rows. Nothing here ever touches
// trade_measures/hts_codes until a human approves and applies — the differ
// stages, the reviewer decides, apply.ts writes.
export const measureRevisions = pgTable(
  "measure_revisions",
  {
    id: id(),
    announcementId: uuid("announcement_id")
      .notNull()
      .references(() => tariffAnnouncements.id, { onDelete: "cascade" }),
    changeType: revisionChangeType("change_type").notNull(),
    ch99Code: varchar("ch99_code", { length: 15 }), // null for stacking_change
    authority: measureAuthority("authority"),
    targetMeasureId: uuid("target_measure_id").references(
      () => tradeMeasures.id,
      { onDelete: "set null" },
    ),
    // ProposedMeasureChange: the full post-apply shape (name, scope,
    // countries, entry/sail windows, rate, prefixes, stacking). Dates and
    // sail cutoffs start null — the structured feed doesn't carry them;
    // humans confirm them from the evidence highlights.
    proposed: jsonb("proposed").notNull(),
    // Source text + SailClauseCandidate[] highlights for the review UI.
    evidence: jsonb("evidence").notNull(),
    // Live measure state at diff time, for the side-by-side diff view.
    liveSnapshot: jsonb("live_snapshot"),
    // sha256 of the source fields — dedupes re-fetches of unchanged rows.
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedMeasureId: uuid("applied_measure_id").references(
      () => tradeMeasures.id,
    ),
    ...timestamps,
  },
  (t) => [
    index("measure_revisions_announcement_idx").on(t.announcementId),
    uniqueIndex("measure_revisions_announcement_code_uq")
      .on(t.announcementId, t.ch99Code)
      .where(sql`${t.ch99Code} is not null`),
  ],
);

// ---------------------------------------------------------------- customs money domain

export const entryLineItems = pgTable(
  "entry_line_items",
  {
    id: id(),
    orgId: orgId(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    partId: uuid("part_id").references(() => parts.id, {
      onDelete: "set null",
    }),
    sku: varchar("sku", { length: 64 }),
    description: text("description"),
    htsCode: varchar("hts_code", { length: 12 }).notNull(), // as declared
    htsCodeDigits: varchar("hts_code_digits", { length: 10 }).notNull(),
    countryOfOrigin: varchar("country_of_origin", { length: 2 }),
    quantity: numeric("quantity", { precision: 15, scale: 4 }),
    unitValue: numeric("unit_value", { precision: 12, scale: 4 }),
    enteredValue: numeric("entered_value", { precision: 12, scale: 2 }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("eli_entry_line_uq").on(t.entryId, t.lineNumber),
    index("eli_org_idx").on(t.orgId),
    index("eli_part_idx").on(t.partId),
  ],
);

// Declared duty/fee lines as ingested from the 7501. Expected charges are
// never stored — the duty calculator re-derives them from reference data on
// demand, so a reference-data change never leaves stale expectations behind.
export const entryLineCharges = pgTable(
  "entry_line_charges",
  {
    id: id(),
    orgId: orgId(),
    lineItemId: uuid("line_item_id")
      .notNull()
      .references(() => entryLineItems.id, { onDelete: "cascade" }),
    chargeType: chargeType("charge_type").notNull(),
    // Chapter 99 code for measures; CBP pseudo-codes "499" (MPF), "501" (HMF).
    htsCode: varchar("hts_code", { length: 15 }),
    htsCodeDigits: varchar("hts_code_digits", { length: 10 }),
    rate: numeric("rate", { precision: 10, scale: 6 }),
    // A $0 amount means the filer claimed an exclusion — it is a statement,
    // not an underpayment, and must never be flagged as a mismatch.
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("elc_line_idx").on(t.lineItemId),
    index("elc_org_idx").on(t.orgId),
  ],
);

// Commercial invoices as first-class records. Linked to a PO when the
// document references one; entries reach invoices through their POs. No
// dedicated UI — invoices surface as source documents and feed audit rules.
export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orgId: orgId(),
    invoiceNumber: varchar("invoice_number", { length: 64 }).notNull(),
    purchaseOrderId: uuid("purchase_order_id").references(
      () => purchaseOrders.id,
      { onDelete: "set null" },
    ),
    supplierName: text("supplier_name"),
    invoiceDate: date("invoice_date"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }),
    incoterms: varchar("incoterms", { length: 64 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invoices_org_number_uq").on(t.orgId, t.invoiceNumber),
    index("invoices_po_idx").on(t.purchaseOrderId),
    index("invoices_org_idx").on(t.orgId),
  ],
);

export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: id(),
    orgId: orgId(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    partId: uuid("part_id").references(() => parts.id, {
      onDelete: "set null",
    }),
    sku: varchar("sku", { length: 64 }),
    description: text("description"),
    quantity: numeric("quantity", { precision: 15, scale: 4 }),
    unitPrice: numeric("unit_price", { precision: 12, scale: 4 }),
    totalPrice: numeric("total_price", { precision: 12, scale: 2 }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ili_invoice_line_uq").on(t.invoiceId, t.lineNumber),
    index("ili_org_idx").on(t.orgId),
    index("ili_part_idx").on(t.partId),
  ],
);

// Written only by the auditor, which reconciles by alert_key: new keys are
// inserted open, open rows are updated or deleted as conditions change, and
// resolved/dismissed rows are never touched.
export const auditAlerts = pgTable(
  "audit_alerts",
  {
    id: id(),
    orgId: orgId(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    // Display metadata only — line scope is encoded in alert_key, so a
    // resolved alert survives wholesale line re-ingestion (set null, not
    // cascade).
    lineItemId: uuid("line_item_id").references(() => entryLineItems.id, {
      onDelete: "set null",
    }),
    alertKey: varchar("alert_key", { length: 160 }).notNull(),
    alertType: auditAlertType("alert_type").notNull(),
    severity: auditSeverity("severity").notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    message: text("message").notNull(),
    details: jsonb("details"),
    status: auditAlertStatus("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("audit_alerts_entry_key_uq").on(t.entryId, t.alertKey),
    index("audit_alerts_org_status_idx").on(t.orgId, t.status),
    index("audit_alerts_entry_idx").on(t.entryId),
  ],
);

// Refund claims from ACE ES-022-style reports, ingested as documents.
// claim_status (the CBP decision) and refund_status (the payout state) are
// independent lifecycle signals; the display stage is derived in code
// (deriveRefundStage), never stored.
export const refundClaims = pgTable(
  "refund_claims",
  {
    id: id(),
    orgId: orgId(),
    entrySummaryNumber: varchar("entry_summary_number", { length: 32 }).notNull(),
    normalizedEntryNumber: varchar("normalized_entry_number", {
      length: 16,
    }).notNull(),
    // Best-effort link by normalized entry number; many report rows cover
    // entries we have never ingested.
    entryId: uuid("entry_id").references(() => entries.id, {
      onDelete: "set null",
    }),
    claimType: varchar("claim_type", { length: 64 }).notNull(),
    claimStatus: varchar("claim_status", { length: 64 }),
    refundStatus: varchar("refund_status", { length: 64 }),
    refundNumber: varchar("refund_number", { length: 32 }),
    refundClassAmount: numeric("refund_class_amount", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),
    refundInterestAmount: numeric("refund_interest_amount", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),
    entryDate: date("entry_date"),
    liquidationDate: date("liquidation_date"),
    refundDate: date("refund_date"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("refund_claims_org_entry_type_uq").on(
      t.orgId,
      t.entrySummaryNumber,
      t.claimType,
    ),
    index("refund_claims_entry_idx").on(t.entryId),
    index("refund_claims_norm_idx").on(t.normalizedEntryNumber),
  ],
);

// ------------------------------------------- classification & review queue
//
// A classification run proposes ranked candidate codes for a part; a human
// decision commits one. Runs are append-only — the latest row per part (by
// uuidv7 id) is current, older rows are the audit history of what the
// classifier said. Human decisions and code changes are recorded in
// review_items and field_changes; parts carries only a projection.

export const htsClassifications = pgTable(
  "hts_classifications",
  {
    id: id(),
    orgId: orgId(),
    partId: uuid("part_id")
      .notNull()
      .references(() => parts.id, { onDelete: "cascade" }),
    status: htsClassificationStatus("status").notNull().default("completed"),
    outcome: htsClassificationOutcome("outcome"),
    classifier: varchar("classifier", { length: 32 }).notNull(), // "stub" | "claude"
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    reasoning: text("reasoning"),
    errorMessage: text("error_message"),
    // Snapshot of what the classifier saw — provenance for its suggestion.
    input: jsonb("input"),
    ...timestamps,
  },
  (t) => [
    index("hts_class_part_idx").on(t.partId),
    index("hts_class_org_idx").on(t.orgId),
  ],
);

export const htsClassificationCandidates = pgTable(
  "hts_classification_candidates",
  {
    id: id(),
    orgId: orgId(),
    classificationId: uuid("classification_id")
      .notNull()
      .references(() => htsClassifications.id, { onDelete: "cascade" }),
    // Product codes only (chapter < 98) — Chapter 99 overlays are measures,
    // not classifications.
    code: varchar("code", { length: 15 }).notNull(),
    codeDigits: varchar("code_digits", { length: 10 }).notNull(),
    description: text("description"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    reason: text("reason"),
    position: integer("position").notNull(), // 0-based rank
    selected: boolean("selected").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("hts_cand_rank_uq").on(t.classificationId, t.position),
    index("hts_cand_class_idx").on(t.classificationId),
  ],
);

// The generic review queue. subject_id is polymorphic per item_type (a part
// for hts_classification, a measure_revisions row for
// tariff_measure_revision) — no FK, same precedent as document_links.
// proposal is a denormalized display payload so the queue list never needs
// polymorphic joins.
export const reviewItems = pgTable(
  "review_items",
  {
    id: id(),
    orgId: orgId(),
    itemType: reviewItemType("item_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    // The row backing this item (an hts_classifications id today).
    payloadId: uuid("payload_id"),
    proposal: jsonb("proposal").notNull(),
    status: reviewItemStatus("status").notNull().default("pending"),
    resolutionAction: reviewAction("resolution_action"),
    decidedBy: text("decided_by"), // free text until auth lands
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    // One open item per subject; resolved history rows are unlimited.
    uniqueIndex("review_items_open_subject_uq")
      .on(t.itemType, t.subjectId)
      .where(sql`${t.status} = 'pending'`),
    index("review_items_org_status_idx").on(t.orgId, t.status),
  ],
);

// Append-only field-level change history. Generic on (entity_type,
// entity_id). Sources: review:accept | review:manual | review:reject |
// manual_edit | classify:auto_provisional | quote:draft_create |
// quote:applied. This is also the actor record behind "changed by <user>"
// provenance in the events feed.
export const fieldChanges = pgTable(
  "field_changes",
  {
    id: id(),
    orgId: orgId(),
    entityType: varchar("entity_type", { length: 32 }).notNull(), // "part"
    entityId: uuid("entity_id").notNull(),
    field: varchar("field", { length: 64 }).notNull(), // "hts_code"
    oldValue: text("old_value"),
    newValue: text("new_value"),
    source: varchar("source", { length: 40 }).notNull(),
    actor: text("actor"),
    note: text("note"),
    reviewItemId: uuid("review_item_id").references(() => reviewItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("field_changes_entity_idx").on(t.entityType, t.entityId)],
);

// ------------------------------------------------------- scenario modeling
//
// Kept in schema, dormant — no engine or UI yet (the future Scenarios page
// will be proactive/intelligent rather than a port). proposed_measures is a
// global curated catalog of announced-but-not-effective tariff actions,
// deliberately SEPARATE from trade_measures so the auditor's guard stays
// structural: loadReferenceData never reads this table.

export const proposedMeasures = pgTable("proposed_measures", {
  id: id(),
  name: text("name").notNull(),
  authority: measureAuthority("authority").notNull(),
  scope: measureScope("scope").notNull().default("hts_list"),
  countries: varchar("countries", { length: 2 }).array(), // null = all
  // Decimal fraction. Allowed on the row (unlike trade_measures) because a
  // code-less proposal has no Chapter 99 row to carry it.
  rate: numeric("rate", { precision: 10, scale: 6 }).notNull(),
  inLieuOfBaseDuty: boolean("in_lieu_of_base_duty").notNull().default(false),
  htsPrefixes: varchar("hts_prefixes", { length: 10 })
    .array()
    .notNull()
    .default([]),
  exclusionPrefixes: varchar("exclusion_prefixes", { length: 10 })
    .array()
    .notNull()
    .default([]),
  announcedDate: date("announced_date"),
  expectedEffectiveDate: date("expected_effective_date"),
  sourceRef: text("source_ref"),
  notes: text("notes"),
  ...timestamps,
});

export const scenarios = pgTable(
  "scenarios",
  {
    id: id(),
    orgId: orgId(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    spec: jsonb("spec").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunSummary: jsonb("last_run_summary"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("scenarios_org_name_uq").on(t.orgId, t.name),
    index("scenarios_org_idx").on(t.orgId),
  ],
);

// ---------------------------------------------------------------- relations

export const entriesRelations = relations(entries, ({ many }) => ({
  entryShipments: many(entryShipments),
  entryPurchaseOrders: many(entryPurchaseOrders),
  lineItems: many(entryLineItems),
  auditAlerts: many(auditAlerts),
  refundClaims: many(refundClaims),
}));

export const shipmentsRelations = relations(shipments, ({ many }) => ({
  entryShipments: many(entryShipments),
  shipmentPurchaseOrders: many(shipmentPurchaseOrders),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ many }) => ({
  entryPurchaseOrders: many(entryPurchaseOrders),
  shipmentPurchaseOrders: many(shipmentPurchaseOrders),
  invoices: many(invoices),
  lines: many(purchaseOrderLines),
}));

export const purchaseOrderLinesRelations = relations(
  purchaseOrderLines,
  ({ one }) => ({
    purchaseOrder: one(purchaseOrders, {
      fields: [purchaseOrderLines.purchaseOrderId],
      references: [purchaseOrders.id],
    }),
    part: one(parts, {
      fields: [purchaseOrderLines.partId],
      references: [parts.id],
    }),
  }),
);

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrders, {
    fields: [invoices.purchaseOrderId],
    references: [purchaseOrders.id],
  }),
  lineItems: many(invoiceLineItems),
}));

export const invoiceLineItemsRelations = relations(
  invoiceLineItems,
  ({ one }) => ({
    invoice: one(invoices, {
      fields: [invoiceLineItems.invoiceId],
      references: [invoices.id],
    }),
    part: one(parts, {
      fields: [invoiceLineItems.partId],
      references: [parts.id],
    }),
  }),
);

export const entryShipmentsRelations = relations(entryShipments, ({ one }) => ({
  entry: one(entries, {
    fields: [entryShipments.entryId],
    references: [entries.id],
  }),
  shipment: one(shipments, {
    fields: [entryShipments.shipmentId],
    references: [shipments.id],
  }),
}));

export const entryPurchaseOrdersRelations = relations(
  entryPurchaseOrders,
  ({ one }) => ({
    entry: one(entries, {
      fields: [entryPurchaseOrders.entryId],
      references: [entries.id],
    }),
    purchaseOrder: one(purchaseOrders, {
      fields: [entryPurchaseOrders.purchaseOrderId],
      references: [purchaseOrders.id],
    }),
  }),
);

export const shipmentPurchaseOrdersRelations = relations(
  shipmentPurchaseOrders,
  ({ one }) => ({
    shipment: one(shipments, {
      fields: [shipmentPurchaseOrders.shipmentId],
      references: [shipments.id],
    }),
    purchaseOrder: one(purchaseOrders, {
      fields: [shipmentPurchaseOrders.purchaseOrderId],
      references: [purchaseOrders.id],
    }),
  }),
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  links: many(documentLinks),
  source: one(integrationSources, {
    fields: [documents.sourceId],
    references: [integrationSources.id],
  }),
}));

export const documentLinksRelations = relations(documentLinks, ({ one }) => ({
  document: one(documents, {
    fields: [documentLinks.documentId],
    references: [documents.id],
  }),
}));

export const partsRelations = relations(parts, ({ many }) => ({
  entryLineItems: many(entryLineItems),
  purchaseOrderLines: many(purchaseOrderLines),
  quoteLines: many(quoteLines),
  htsClassifications: many(htsClassifications),
}));

export const quoteSheetsRelations = relations(quoteSheets, ({ one, many }) => ({
  document: one(documents, {
    fields: [quoteSheets.documentId],
    references: [documents.id],
  }),
  lines: many(quoteLines),
}));

export const quoteLinesRelations = relations(quoteLines, ({ one }) => ({
  quoteSheet: one(quoteSheets, {
    fields: [quoteLines.quoteSheetId],
    references: [quoteSheets.id],
  }),
  part: one(parts, {
    fields: [quoteLines.partId],
    references: [parts.id],
  }),
  appliedPoLine: one(purchaseOrderLines, {
    fields: [quoteLines.appliedPoLineId],
    references: [purchaseOrderLines.id],
  }),
}));

export const htsClassificationsRelations = relations(
  htsClassifications,
  ({ one, many }) => ({
    part: one(parts, {
      fields: [htsClassifications.partId],
      references: [parts.id],
    }),
    candidates: many(htsClassificationCandidates),
  }),
);

export const htsClassificationCandidatesRelations = relations(
  htsClassificationCandidates,
  ({ one }) => ({
    classification: one(htsClassifications, {
      fields: [htsClassificationCandidates.classificationId],
      references: [htsClassifications.id],
    }),
  }),
);

export const tradeMeasuresRelations = relations(
  tradeMeasures,
  ({ one, many }) => ({
    htsCodes: many(htsCodes),
    htsPrefixes: many(tradeMeasureHts),
    predecessor: one(tradeMeasures, {
      fields: [tradeMeasures.predecessorId],
      references: [tradeMeasures.id],
      relationName: "measureLineage",
    }),
    successors: many(tradeMeasures, { relationName: "measureLineage" }),
  }),
);

export const tariffAnnouncementsRelations = relations(
  tariffAnnouncements,
  ({ many }) => ({
    revisions: many(measureRevisions),
  }),
);

export const measureRevisionsRelations = relations(
  measureRevisions,
  ({ one }) => ({
    announcement: one(tariffAnnouncements, {
      fields: [measureRevisions.announcementId],
      references: [tariffAnnouncements.id],
    }),
    targetMeasure: one(tradeMeasures, {
      fields: [measureRevisions.targetMeasureId],
      references: [tradeMeasures.id],
      relationName: "revisionTarget",
    }),
    appliedMeasure: one(tradeMeasures, {
      fields: [measureRevisions.appliedMeasureId],
      references: [tradeMeasures.id],
      relationName: "revisionApplied",
    }),
  }),
);

export const htsCodesRelations = relations(htsCodes, ({ one }) => ({
  tradeMeasure: one(tradeMeasures, {
    fields: [htsCodes.tradeMeasureId],
    references: [tradeMeasures.id],
  }),
}));

export const tradeMeasureHtsRelations = relations(
  tradeMeasureHts,
  ({ one }) => ({
    tradeMeasure: one(tradeMeasures, {
      fields: [tradeMeasureHts.tradeMeasureId],
      references: [tradeMeasures.id],
    }),
  }),
);

export const entryLineItemsRelations = relations(
  entryLineItems,
  ({ one, many }) => ({
    entry: one(entries, {
      fields: [entryLineItems.entryId],
      references: [entries.id],
    }),
    part: one(parts, {
      fields: [entryLineItems.partId],
      references: [parts.id],
    }),
    charges: many(entryLineCharges),
    auditAlerts: many(auditAlerts),
  }),
);

export const entryLineChargesRelations = relations(
  entryLineCharges,
  ({ one }) => ({
    lineItem: one(entryLineItems, {
      fields: [entryLineCharges.lineItemId],
      references: [entryLineItems.id],
    }),
  }),
);

export const auditAlertsRelations = relations(auditAlerts, ({ one }) => ({
  entry: one(entries, {
    fields: [auditAlerts.entryId],
    references: [entries.id],
  }),
  lineItem: one(entryLineItems, {
    fields: [auditAlerts.lineItemId],
    references: [entryLineItems.id],
  }),
}));

export const refundClaimsRelations = relations(refundClaims, ({ one }) => ({
  entry: one(entries, {
    fields: [refundClaims.entryId],
    references: [entries.id],
  }),
}));

export const integrationSourcesRelations = relations(
  integrationSources,
  ({ many }) => ({
    documents: many(documents),
  }),
);

// ---------------------------------------------------------------- row types

export type Org = typeof orgs.$inferSelect;
export type Entry = typeof entries.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
export type Document = typeof documents.$inferSelect;
// Document without the raw provider payload — what list queries return and
// what travels to the client. raw_extraction stays server-side.
export type DocumentListItem = Omit<Document, "rawExtraction">;
export type DocumentLink = typeof documentLinks.$inferSelect;
export type Part = typeof parts.$inferSelect;
export type QuoteSheet = typeof quoteSheets.$inferSelect;
export type QuoteLine = typeof quoteLines.$inferSelect;
export type IntegrationSource = typeof integrationSources.$inferSelect;

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type HtsCode = typeof htsCodes.$inferSelect;
export type TradeMeasure = typeof tradeMeasures.$inferSelect;
export type TradeMeasureHtsRow = typeof tradeMeasureHts.$inferSelect;
export type StackingRule = typeof stackingRules.$inferSelect;
export type EntryLineItem = typeof entryLineItems.$inferSelect;
export type EntryLineCharge = typeof entryLineCharges.$inferSelect;
export type AuditAlert = typeof auditAlerts.$inferSelect;
export type RefundClaim = typeof refundClaims.$inferSelect;
export type HtsClassification = typeof htsClassifications.$inferSelect;
export type HtsClassificationCandidate =
  typeof htsClassificationCandidates.$inferSelect;
export type ReviewItem = typeof reviewItems.$inferSelect;
export type FieldChange = typeof fieldChanges.$inferSelect;
export type ProposedMeasure = typeof proposedMeasures.$inferSelect;
export type Scenario = typeof scenarios.$inferSelect;
export type TariffAnnouncement = typeof tariffAnnouncements.$inferSelect;
export type MeasureRevision = typeof measureRevisions.$inferSelect;

export type EntryStatus = Entry["status"];
export type ShipmentStatus = Shipment["status"];
export type PoStatus = PurchaseOrder["status"];
export type PartStatus = Part["status"];
export type QuoteLineStatus = QuoteLine["status"];
export type IntegrationKind = IntegrationSource["kind"];
export type IntegrationStatusValue = IntegrationSource["status"];
export type DocumentTypeValue = Document["docType"];
export type DocumentStatusValue = Document["status"];
export type ChargeTypeValue = EntryLineCharge["chargeType"];
export type MeasureAuthorityValue = TradeMeasure["authority"];
export type MeasureScopeValue = TradeMeasure["scope"];
export type HtsRateTypeValue = HtsCode["rateType"];
export type AuditAlertTypeValue = AuditAlert["alertType"];
export type AuditSeverityValue = AuditAlert["severity"];
export type AuditAlertStatusValue = AuditAlert["status"];
export type HtsClassificationOutcomeValue = NonNullable<
  HtsClassification["outcome"]
>;
export type ReviewItemStatusValue = ReviewItem["status"];
export type ReviewActionValue = NonNullable<ReviewItem["resolutionAction"]>;
export type PartHtsReviewStatusValue = NonNullable<Part["htsReviewStatus"]>;
export type AnnouncementSourceValue = TariffAnnouncement["source"];
export type AnnouncementStatusValue = TariffAnnouncement["status"];
export type RevisionChangeTypeValue = MeasureRevision["changeType"];
