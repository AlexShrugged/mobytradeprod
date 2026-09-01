// MobyTrade schema. Carried from mobynew with these deltas:
//   - kits/kit_parts dropped (unused by customers)
//   - parts: boolean `active` replaced by status draft|active|archived
//   - net-new: vendors + part_sources (a SKU can be sourced from multiple
//     vendors; the (part, vendor) row owns country of origin and unit cost —
//     the SKU alone does not define them),
//     quote_sheets/quote_lines (quotes absorbed into parts),
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
  check,
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

export const shipmentMode = pgEnum("shipment_mode", [
  "ocean",
  "air",
  "truck",
  "rail",
]);
export const documentType = pgEnum("document_type", [
  "port_entry",
  // A CBP Form 3461 / broker cargo release notification. Carries an entry
  // number but is NOT the entry summary: it links to an existing entry and
  // never creates one (a release has no entry date or duty lines, so letting
  // it mint entries is how dateless header-less entries were born).
  "cargo_release",
  "shipment",
  "purchase_order",
  "commercial_invoice",
  "packing_list",
  "quote_sheet",
  "refund_report",
  // A bundled multi-document broker packet (7501 + commercial invoice +
  // supporting docs in one PDF). Processing splits it into child documents;
  // the parent's extracted_data is the split manifest.
  "entry_packet",
  // A broker "entry tariff code sheet" — ABI software output mapping each
  // commercial-invoice line (part number, PO) to the 7501 line it was filed
  // under. The only document that STATES the CI↔7501 join; its rows persist
  // as entry_line_parts (declared broker facts, not inference).
  "tariff_code_sheet",
  // A SKU list imported on the Parts page (CSV/XLSX). Applied by the parts
  // importer at upload time — these rows are born "processed" and never go
  // through the document pipeline (no Reducto/stub processor for them).
  "part_catalog",
  "other",
]);
// Role of a child document inside an entry packet — the split classifier's
// vocabulary (ported from the legacy broker_entry_packet domain rules).
export const packetRole = pgEnum("packet_role", [
  "entry_summary_7501",
  // The 3461/cargo-release pages of a packet: entry-numbered but never the
  // entry's source of truth (see documentType "cargo_release").
  "cargo_release",
  "commercial_invoice",
  // Assist sheets look columnar like commercial invoices; keeping them a
  // distinct role (mapped to docType "other") is what stops them becoming
  // bogus invoices with spurious value-mismatch alerts.
  "assist_sheet",
  // Same trap, different document: the broker's own bill (brokerage fees,
  // duty advancement) is invoice-shaped but must never enter the
  // commercial_invoice pipeline.
  "broker_invoice",
  "packing_list",
  "transport_document",
  "certificate_of_origin",
  "hts_code_list",
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
// Statute first; product qualifier only where one statute carries multiple
// product actions (Section 232's per-proclamation regimes). The legacy
// platform's flat "timber_furniture"/"pharmaceutical" names were display
// drift — its own seeders call them Section 232 regimes (Proclamation 10976;
// U.S. note 51(c) groups pharma with the 232 family).
export const measureAuthority = pgEnum("measure_authority", [
  "section_301",
  "section_232_steel",
  "section_232_aluminum",
  "section_232_copper",
  "section_232_autos",
  "section_232_timber_furniture",
  "section_232_pharma",
  "section_338",
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
  // Declared country of origin disagrees with the catalog's (part, vendor)
  // sourcing facts.
  "coo_discrepancy",
  // Declared code matched the catalog as of the entry date, but the part has
  // since been reclassified — potential retroactive correction/refund.
  "hts_reclassified",
  "value_mismatch",
  "data_unreconciled",
  // Sail-conditioned expectations were computed from an estimated (ETD
  // fallback) or assumed (no date at all) sail date.
  "sail_date_assumption",
  // --- commercial-invoice document comparisons (CI vs entry) ---
  // Quantities aren't money, so value_mismatch can't carry them.
  "quantity_discrepancy",
  // Distinct from hts_discrepancy: that type's impact/detail UI computes
  // catalog counterfactuals, which are wrong for CI evidence (same reason
  // hts_reclassified was split out).
  "invoice_hts_mismatch",
  // An entry SKU absent from the linked commercial invoice(s). Distinct from
  // data_unreconciled, which suppresses ALL impact on the entry.
  "invoice_sku_missing",
  // CI comparison was skipped (e.g. non-USD invoice — no FX support).
  "invoice_comparison_skipped",
  // A declared line SKU with no catalog part (part_id null) while the org
  // HAS a catalog — either a catalog gap or a bad SKU on the filing, and
  // the catalog checks (HTS, origin) silently skip the line until fixed.
  "unknown_sku",
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
  // One card spanning every create_measure revision in a (authority, Ch99
  // 6-digit prefix) family — wholesale adoption without hundreds of
  // atomized cards. subject_id = measure_revision_groups.id.
  "tariff_measure_group",
  // Release-level approval of a base-schedule (ch. 1–97) refresh.
  // subject_id = the "<release>-base" tariff_announcements.id.
  "tariff_base_release",
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
// newer quote for the same (part, vendor) arrives while still un-approved.
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
// Must stay value-identical to findingCategorySchema in
// src/lib/analysis/findings.ts (asserted by analysis/service.test.ts) —
// the analyst's output enum IS this column's vocabulary.
export const analysisFindingCategory = pgEnum("analysis_finding_category", [
  "adcvd_discrepancy",
  "fee_error",
  "coo_inconsistency",
  "classification_mismatch",
  "valuation_concern",
  "document_inconsistency",
  "duty_calculation",
  "other",
]);
export const analysisRunStatus = pgEnum("analysis_run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export const analysisRunTrigger = pgEnum("analysis_run_trigger", [
  "manual",
  "tariff_apply",
  // An org rule changed (created, edited, toggled, deleted) — the analyst's
  // standing instructions moved, so its prior judgments need re-deriving.
  "org_rule",
]);
export const adcvdOrderStatus = pgEnum("adcvd_order_status", [
  "active",
  "revoked",
]);

// ---------------------------------------------------------------- tenancy

export const orgs = pgTable("orgs", {
  id: id(),
  // Clerk Organization backing this tenant; null only for the local seed
  // org when SEED_CLERK_ORG_ID is unset (auth-disabled dev).
  clerkOrgId: text("clerk_org_id").unique(),
  name: text("name").notNull(),
  importerOfRecord: text("importer_of_record"),
  // The purpose-built document intake address shown on the Data page.
  inboxAddress: text("inbox_address"),
  // The org's one human operator — recorded as actor/decidedBy on manual
  // edits until auth lands. Falls back to the org name when unset.
  defaultActorName: text("default_actor_name"),
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
    // No status column: entries only exist because a 7501 was processed
    // (filed by construction); liquidation derives on read from linked
    // refund claims' printed liquidation dates (entries/status.ts).
    // "released" was dropped outright — no ingested document evidences it.
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
    // No status column: lifecycle state is DERIVED on read from the date
    // facts + entry links (shipments/status.ts) — no ingested document can
    // assert "arrived", so a stored status could only go stale.
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
    // As printed on the document (declared fact) + the resolved vendor.
    supplierName: text("supplier_name"),
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
    orderDate: date("order_date"),
    expectedDate: date("expected_date"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }),
    // No status column: receipt is a warehouse event no ingested document
    // evidences (we take no receiving docs/GRNs), so open/received states
    // could only ever be fiction.
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
    // Declared per-line origin when the PO logs one (vendor/SKU defines COO).
    countryOfOrigin: varchar("country_of_origin", { length: 2 }),
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
    // Entry-packet parent-child: a packet child is an ordinary document row
    // (own status/extraction/links lifecycle) pointing at its packet parent.
    // Children share the parent's storage_key — page_range (1-indexed pages
    // of the parent PDF) scopes what "this document" means; there is no
    // physical PDF slicing.
    parentDocumentId: uuid("parent_document_id").references(
      (): AnyPgColumn => documents.id,
      { onDelete: "cascade" },
    ),
    packetRole: packetRole("packet_role"),
    pageRange: integer("page_range").array(),
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
    index("documents_parent_idx").on(t.parentDocumentId),
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

// A vendor as the org knows them. Documents keep the supplier name exactly as
// printed (declared fact) plus a resolved vendor_id — the same pattern line
// items use for sku + part_id. Rows are find-or-created by normalized name;
// sole writer: vendors/service.ts. Rename is the only edit (no delete/merge).
export const vendors = pgTable(
  "vendors",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    // trim + casefold — the find-or-create identity key. Deliberately
    // conservative: no suffix stripping ("Co." vs "Ltd." may be two firms).
    nameNormalized: text("name_normalized").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("vendors_org_name_uq").on(t.orgId, t.nameNormalized),
    index("vendors_org_idx").on(t.orgId),
  ],
);

export const parts = pgTable(
  "parts",
  {
    id: id(),
    orgId: orgId(),
    sku: varchar("sku", { length: 64 }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    unitOfMeasure: varchar("unit_of_measure", { length: 16 })
      .notNull()
      .default("EA"),
    // Cost and country of origin are NOT here: the SKU alone does not define
    // them — the (part, vendor) combination does. See part_sources.
    //
    // hts_code is the CURRENT-WINDOW PROJECTION of part_classifications: a
    // part has an open classification window iff hts_code is set and not
    // provisional. Historical windows live in part_classifications so audits
    // resolve the code as of the entry date.
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

// One row per (part, vendor): the catalog's sourcing facts. The OFFICIAL cost
// and origin for that vendor — written by manual edit (sources routes) or by
// quotes/service.ts when an approved quote's PO confirms it, the same split
// these fields had as parts columns. Draft parts carry the quote's values
// (draft means "not official" — that is the guard). Landed-cost estimates,
// future-entry projections, and the COO audit rule all read from here.
export const partSources = pgTable(
  "part_sources",
  {
    id: id(),
    orgId: orgId(),
    partId: uuid("part_id")
      .notNull()
      .references(() => parts.id, { onDelete: "cascade" }),
    // No cascade: vendors have no delete path (rename only).
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    countryOfOrigin: varchar("country_of_origin", { length: 2 }),
    unitCost: numeric("unit_cost", { precision: 10, scale: 4 }),
    // Change-tiling window, same idiom as hts_codes base windows: null
    // valid_from = open start, null valid_to = current. A cost/COO change
    // closes the current window at effective − 1 and opens a successor, so
    // historical entries audit against the sourcing facts of their day.
    // "Deleting" a source closes its window rather than erasing history.
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    ...timestamps,
  },
  (t) => [
    // One CURRENT window per (part, vendor); closed windows are history.
    uniqueIndex("part_sources_part_vendor_current_uq")
      .on(t.partId, t.vendorId)
      .where(sql`${t.validTo} is null`),
    index("part_sources_org_idx").on(t.orgId),
    index("part_sources_vendor_idx").on(t.vendorId),
  ],
);

// Committed HTS classification windows per part — the effective-dated truth
// behind the parts.hts_code projection. Written ONLY by
// classification/service.ts (same single-writer doctrine as the projection).
// Provisional codes and draft-part quote claims never create windows; a
// window records a committed human decision. Windows for one part never
// overlap: a dated reclassification closes the current window at
// effective − 1 (tiling), an undated commit corrects the current window in
// place ("wrong all along"). Audits resolve the code as of the entry date,
// falling back to the current window when the entry has no date or predates
// every window — byte-identical to pre-windowing behavior.
export const partClassifications = pgTable(
  "part_classifications",
  {
    id: id(),
    orgId: orgId(),
    partId: uuid("part_id")
      .notNull()
      .references(() => parts.id, { onDelete: "cascade" }),
    htsCode: varchar("hts_code", { length: 12 }).notNull(),
    // null valid_from = open start ("as long as we've known the part");
    // null valid_to = current.
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    // Same vocabulary as field_changes.source, plus "backfill" (migration)
    // and "seed".
    source: varchar("source", { length: 40 }).notNull(),
    actor: text("actor"),
    note: text("note"),
    reviewItemId: uuid("review_item_id").references(() => reviewItems.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    // One CURRENT window per part; closed windows are history.
    uniqueIndex("part_classifications_current_uq")
      .on(t.partId)
      .where(sql`${t.validTo} is null`),
    index("part_classifications_part_idx").on(t.partId),
    index("part_classifications_org_idx").on(t.orgId),
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
    // As printed on the sheet (declared fact) + the resolved vendor.
    supplierName: text("supplier_name"),
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
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

// ---------------------------------------------------------------- org rules
//
// Standing instructions an importer records, shown on the Settings page. Tier 1:
// a rule may carry a structured suppression spec (alert types + optional
// supplier/COO/HTS-prefix scope, zod-validated in the routes) that filters
// the auditor's desired alerts before reconcile — rule changes trigger an
// org sweep so open alerts clear/reappear; resolved and dismissed rows are
// never touched. Tier 2: every enabled rule's text injects into the entry
// analyst's and assistant's prompts as standing instructions. Written ONLY
// by the org-rules routes (manual Settings-page CRUD and assistant-confirmed
// save_org_rule proposals both execute through them). Rule kind (suppression
// vs guidance) derives from spec presence on read — never stored. Suppression
// narrows alerting, never duty math; no custom deterministic checks live here.

export const orgRules = pgTable(
  "org_rules",
  {
    id: id(),
    orgId: orgId(),
    /** One concise sentence — shown verbatim in the UI and in AI prompts. */
    text: text("text").notNull(),
    /** SuppressionSpec jsonb (src/lib/org-rules.ts); null = guidance-only. */
    suppression: jsonb("suppression"),
    enabled: boolean("enabled").notNull().default(true),
    /** "manual" | "assistant" — varchar for growth (agent_proposals.kind precedent). */
    source: varchar("source", { length: 16 }).notNull().default("manual"),
    createdByName: text("created_by_name").notNull(),
    ...timestamps,
  },
  (t) => [index("org_rules_org_enabled_idx").on(t.orgId, t.enabled)],
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
    // Stable identity of the legal program this measure belongs to
    // ("ieepa-reciprocal", "section-301-china") — the calculator's
    // exclusivity key: at most ONE measure per program applies to a line
    // (CBP partitions a program across Chapter 99 headings — baseline vs
    // country-specific rates, pre/post-escalation windows — whose article
    // descriptions carve each other out). Distinct programs under the same
    // statute still stack (IEEPA fentanyl + IEEPA reciprocal shared one
    // entry line), so authority is a display bucket, never this key. The
    // instrument (EO/FR number) belongs in notes — orders get amended;
    // the program persists. Null = lineage unknown: never deduped.
    program: text("program"),
    scope: measureScope("scope").notNull().default("hts_list"),
    // Countries of origin the measure applies to; null = every country.
    countries: varchar("countries", { length: 2 }).array(),
    // Annex-style carve-outs: countries the measure does NOT apply to
    // ("all countries except…"). Null/empty = no exclusions. Checked after
    // the inclusion list; an unknown COO is NOT excluded (expectations bias
    // toward duty owed, same as sail assumptions).
    countriesExcluded: varchar("countries_excluded", { length: 2 }).array(),
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
    // Cross-program statutory carve-out (exemption rows only): when a
    // measure of this program applies to a line, the parent measure is
    // displaced and THIS exemption heading is the expected filing (e.g.
    // Section 122's 9903.03.06 displaces the 10% surcharge on lines the
    // Section 232 metals program covers). Null = ordinary exemption.
    carveoutTriggerProgram: text("carveout_trigger_program"),
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

// One reviewable "adopt this measure family" unit: the payload behind a
// review_items row (item_type "tariff_measure_group", subject_id = this
// row's id), grouping the create_measure revisions that share an authority
// and Chapter 99 6-digit prefix within one announcement. Member counts are
// derived at read time from measure_revisions (applied/superseded members
// drop out) — never stored.
export const measureRevisionGroups = pgTable(
  "measure_revision_groups",
  {
    id: id(),
    announcementId: uuid("announcement_id")
      .notNull()
      .references(() => tariffAnnouncements.id, { onDelete: "cascade" }),
    authority: measureAuthority("authority").notNull(),
    ch99Prefix: varchar("ch99_prefix", { length: 6 }).notNull(),
    title: text("title").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mrg_announcement_key_uq").on(
      t.announcementId,
      t.authority,
      t.ch99Prefix,
    ),
  ],
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
    // Membership in a tariff_measure_group card. Grouped members carry no
    // per-revision review item — the group's item gates them all.
    groupId: uuid("group_id").references(() => measureRevisionGroups.id, {
      onDelete: "set null",
    }),
    // A newer sync re-staged this code (content changed): terminal, like a
    // superseded review item. Individual revisions get BOTH this stamp and
    // the item-status flip so open-revision loading has one predicate.
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
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
    // Special Program Indicator prefixed to the HTS number on the 7501
    // ("KR", "A", "AU"): the broker's claimed FTA/GSP preference. A declared
    // fact — the calculator resolves it against the schedule's special-rates
    // column on read (duty/special-rates.ts). Null = no claim.
    spi: varchar("spi", { length: 8 }),
    countryOfOrigin: varchar("country_of_origin", { length: 2 }),
    // Per-line supplier as declared on the 7501 (entries can span vendors) +
    // the resolved vendor — feeds the COO-vs-catalog audit rule.
    supplierName: text("supplier_name"),
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
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

// Which catalog parts sit behind each 7501 line, as DECLARED by a broker
// tariff code sheet (docType "tariff_code_sheet") — one row per (line, part
// number) the sheet maps. Written only by processing/linker.ts, wholesale-
// replaced per source document on reprocess. Keyed by (entry, line_number)
// rather than entry_line_items.id because 7501 reprocessing replaces line
// rows wholesale — the mapping is a fact about the filing, not the row.
// This table holds declared facts only: the CI-derived line↔part inference
// is computed on read (parts/line-parts.ts) and never stored.
export const entryLineParts = pgTable(
  "entry_line_parts",
  {
    id: id(),
    orgId: orgId(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    // The part number as printed on the sheet + the resolved catalog part.
    sku: varchar("sku", { length: 64 }).notNull(),
    partId: uuid("part_id").references(() => parts.id, {
      onDelete: "set null",
    }),
    poNumber: varchar("po_number", { length: 64 }),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("elp_entry_line_sku_uq").on(t.entryId, t.lineNumber, t.sku),
    index("elp_org_idx").on(t.orgId),
    index("elp_part_idx").on(t.partId),
  ],
);

// Commercial invoices as first-class records. Linked to a PO when the
// document references one, and DIRECTLY to entries via entry_invoices —
// the CI is the primary document an entry is checked against for variance.
// Invoices surface on entry detail and in audit alerts, not as their own page.
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
    // As printed on the invoice (declared fact) + the resolved vendor.
    supplierName: text("supplier_name"),
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
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
    // Declared per-line origin when the invoice logs one.
    countryOfOrigin: varchar("country_of_origin", { length: 2 }),
    // HTS/HS code as printed on the invoice line — often a 6/8-digit HS
    // code, not a full 10-digit HTS, and many CIs omit it entirely. Digits
    // precomputed for prefix comparison against entry_line_items.
    htsCode: varchar("hts_code", { length: 12 }),
    htsCodeDigits: varchar("hts_code_digits", { length: 10 }),
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

// Direct entry↔invoice links — which commercial invoices document which
// entry. Written only by processing/linker.ts (packet siblings, invoice
// numbers referenced on the 7501, shared-PO fallback). The CI variance rules
// read invoices exclusively through this table, never via POs.
export const entryInvoices = pgTable(
  "entry_invoices",
  {
    orgId: orgId(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.invoiceId] }),
    index("ei_invoice_idx").on(t.invoiceId),
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
    // Null = platform-global item (tariff reference changes, reviewed by the
    // super admin — the data they gate has no org). Non-null = tenant-scoped
    // (hts_classification). The CHECK below makes scope a function of
    // item_type rather than caller discipline.
    orgId: uuid("org_id").references(() => orgs.id),
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
    // ::text on purpose: lets the migration that ADDs the enum values
    // reference them in a CHECK without "unsafe use of new value".
    check(
      "review_items_scope_check",
      sql`(${t.orgId} is null) = (${t.itemType}::text in ('tariff_measure_revision', 'tariff_measure_group', 'tariff_base_release'))`,
    ),
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
    // Set when the change is scoped to one (part, vendor) source row —
    // unit_cost/country_of_origin edits. The grain stays entity_type="part"
    // so events scoping and history filters keep working; the vendor id only
    // qualifies the title ("unit cost changed on EB-X — Vendor Co").
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
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

// ---------------------------------------------------------------- AI analysis
//
// The AI entry analyst's persisted surface. analysis_runs is the work log —
// and, via status "pending", the re-analysis queue tariff applies enqueue
// into. analysis_findings mirrors audit_alerts' reconcile contract: rows
// reconcile by finding_key, resolved/dismissed rows are never touched by a
// re-analysis. src/lib/analysis/service.ts is the sole writer of both (the
// findings PATCH route records human status decisions, exactly as the
// alerts route does for audit_alerts).

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: id(),
    orgId: orgId(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    status: analysisRunStatus("status").notNull().default("pending"),
    trigger: analysisRunTrigger("trigger").notNull(),
    /** "claude" | "stub" — null while pending. */
    analyst: varchar("analyst", { length: 16 }),
    model: varchar("model", { length: 64 }),
    summary: text("summary"),
    error: text("error"),
    usage: jsonb("usage"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("analysis_runs_entry_idx").on(t.entryId),
    index("analysis_runs_org_status_idx").on(t.orgId, t.status),
    // The queue holds at most one pending row per entry — a second tariff
    // apply before processing must not double-enqueue.
    uniqueIndex("analysis_runs_entry_pending_uq")
      .on(t.entryId)
      .where(sql`status = 'pending'`),
  ],
);

export const analysisFindings = pgTable(
  "analysis_findings",
  {
    id: id(),
    orgId: orgId(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    // Display metadata only — line scope is encoded in finding_key, so a
    // decided finding survives wholesale line re-ingestion (set null, not
    // cascade), mirroring audit_alerts.line_item_id.
    lineItemId: uuid("line_item_id").references(() => entryLineItems.id, {
      onDelete: "set null",
    }),
    findingKey: varchar("finding_key", { length: 160 }).notNull(),
    category: analysisFindingCategory("category").notNull(),
    severity: auditSeverity("severity").notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    suggestedAction: text("suggested_action").notNull(),
    /** 0..1, three decimals — the analyst's calibrated confidence. */
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    lineNumber: integer("line_number"),
    /** FindingField[] (analysis/findings.ts) — the filed-vs-expected diff
     *  the reconciliation UI renders as its field table. */
    fields: jsonb("fields").notNull().default([]),
    /** FindingEvidence[] (analysis/findings.ts) — verbatim quotes plus a
     *  human statement per item. */
    evidence: jsonb("evidence").notNull(),
    /** Deterministic alertKeys this finding corroborates; [] = novel.
     *  Corroborations stay off the variance queue (the alert row already
     *  carries the issue) and render as context on the entry page. */
    relatedAlertKeys: jsonb("related_alert_keys").notNull(),
    /** The run that last wrote this row's content. */
    runId: uuid("run_id").references(() => analysisRuns.id, {
      onDelete: "set null",
    }),
    status: auditAlertStatus("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("analysis_findings_entry_key_uq").on(t.entryId, t.findingKey),
    index("analysis_findings_org_status_idx").on(t.orgId, t.status),
    index("analysis_findings_entry_idx").on(t.entryId),
  ],
);

// ---------------------------------------------------------------- assistant
//
// The org-facing assistant's persisted surface: conversations, the raw
// Anthropic message transcript (content blocks stored verbatim, so a
// conversation resumes byte-identically), and propose-and-confirm action
// cards. The agent holds no write tools — proposals execute only when a
// human confirms them through the existing decision routes.
// src/lib/agent/service.ts is the sole writer of all three tables (the
// proposals PATCH route records the human's confirm/dismiss through it).

export const agentConversations = pgTable(
  "agent_conversations",
  {
    id: id(),
    orgId: orgId(),
    title: varchar("title", { length: 120 })
      .notNull()
      .default("New conversation"),
    /** Who opened the conversation — display attribution only
     *  (conversations are org-shared, like every other surface). */
    createdByName: text("created_by_name"),
    /** Soft turn lock: set while a turn streams, cleared when it settles.
     *  A crashed turn's stale lock is reclaimable after deadline + grace. */
    turnStartedAt: timestamp("turn_started_at", { withTimezone: true }),
    lastTurnAt: timestamp("last_turn_at", { withTimezone: true }),
    /** AgentUsage of the most recent turn. */
    lastUsage: jsonb("last_usage"),
    /** Pathname the conversation was opened from (embedded widget only;
     *  null for /assistant threads). Client sends a validated pathname,
     *  never free text — the human-readable description is derived
     *  server-side and injected into the system prompt as context. */
    contextPath: text("context_path"),
    ...timestamps,
  },
  (t) => [
    index("agent_conversations_org_updated_idx").on(t.orgId, t.updatedAt),
  ],
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: id(),
    orgId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    /** Transcript order — concatenating rows by seq rebuilds the exact
     *  Anthropic messages array (tool_use/tool_result blocks included). */
    seq: integer("seq").notNull(),
    /** "user" | "assistant" — the Anthropic wire roles (tool results ride
     *  in user messages, exactly as the SDK accumulates them). */
    role: varchar("role", { length: 16 }).notNull(),
    /** Raw Anthropic content blocks (string content normalized to a text
     *  block on write). Display projections derive from these on read. */
    content: jsonb("content").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("agent_messages_conversation_seq_uq").on(
      t.conversationId,
      t.seq,
    ),
  ],
);

export const agentProposals = pgTable(
  "agent_proposals",
  {
    id: id(),
    orgId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    /** The assistant message whose propose_actions call created this card;
     *  backfilled once that message persists (display anchoring only). */
    messageId: uuid("message_id").references(() => agentMessages.id, {
      onDelete: "set null",
    }),
    /** "alert_decision" | "analyze_entry". */
    kind: varchar("kind", { length: 32 }).notNull(),
    /** Self-contained card payload (AgentProposalPayload) — everything the
     *  card renders without joins; unit ids are expanded at propose time. */
    payload: jsonb("payload").notNull(),
    /** "proposed" | "confirmed" | "dismissed" — the human's call on the
     *  card. The underlying alert decision lives on the alert rows. */
    status: varchar("status", { length: 16 }).notNull().default("proposed"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Per-target outcomes recorded at confirm ([{id, ok}]). */
    results: jsonb("results"),
    ...timestamps,
  },
  (t) => [
    index("agent_proposals_conversation_idx").on(t.conversationId),
    index("agent_proposals_org_status_idx").on(t.orgId, t.status),
  ],
);

// AD/CVD order corpus — global reference like hts_codes (no org_id).
// Seeded as demo approximations (the same caveat as pre-certification
// "SEED" base windows); a certified ingest corrects rows in place later.
// Read by the analyst's get_adcvd_orders tool: scope summaries and deposit
// rates are indicative context for the model, never inputs to deterministic
// duty math.
export const adcvdOrders = pgTable(
  "adcvd_orders",
  {
    id: id(),
    /** Commerce case number, e.g. A-570-121 (A- = AD, C- = CVD). */
    caseNumber: varchar("case_number", { length: 20 }).notNull().unique(),
    country: varchar("country", { length: 2 }).notNull(),
    merchandise: varchar("merchandise", { length: 200 }).notNull(),
    scopeSummary: text("scope_summary").notNull(),
    /** Indicative HTS prefixes (dotted or bare digits); scope language
     *  governs, so membership here is a signal, not a verdict. */
    htsPrefixes: jsonb("hts_prefixes").notNull(),
    status: adcvdOrderStatus("status").notNull().default("active"),
    effectiveDate: date("effective_date"),
    revokedDate: date("revoked_date"),
    /** [{ producer: string | null, rate: number }] — decimal-fraction
     *  cash-deposit rates; null producer = the all-others rate. */
    depositRates: jsonb("deposit_rates").notNull(),
    source: text("source"),
    ...timestamps,
  },
  (t) => [index("adcvd_orders_country_idx").on(t.country)],
);

// ---------------------------------------------------------------- relations

export const entriesRelations = relations(entries, ({ many }) => ({
  entryShipments: many(entryShipments),
  entryPurchaseOrders: many(entryPurchaseOrders),
  entryInvoices: many(entryInvoices),
  lineItems: many(entryLineItems),
  lineParts: many(entryLineParts),
  auditAlerts: many(auditAlerts),
  analysisFindings: many(analysisFindings),
  analysisRuns: many(analysisRuns),
  refundClaims: many(refundClaims),
}));

export const shipmentsRelations = relations(shipments, ({ many }) => ({
  entryShipments: many(entryShipments),
  shipmentPurchaseOrders: many(shipmentPurchaseOrders),
}));

export const purchaseOrdersRelations = relations(
  purchaseOrders,
  ({ one, many }) => ({
    entryPurchaseOrders: many(entryPurchaseOrders),
    shipmentPurchaseOrders: many(shipmentPurchaseOrders),
    invoices: many(invoices),
    lines: many(purchaseOrderLines),
    vendor: one(vendors, {
      fields: [purchaseOrders.vendorId],
      references: [vendors.id],
    }),
  }),
);

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
  vendor: one(vendors, {
    fields: [invoices.vendorId],
    references: [vendors.id],
  }),
  lineItems: many(invoiceLineItems),
  entryInvoices: many(entryInvoices),
}));

export const entryInvoicesRelations = relations(entryInvoices, ({ one }) => ({
  entry: one(entries, {
    fields: [entryInvoices.entryId],
    references: [entries.id],
  }),
  invoice: one(invoices, {
    fields: [entryInvoices.invoiceId],
    references: [invoices.id],
  }),
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
  parent: one(documents, {
    fields: [documents.parentDocumentId],
    references: [documents.id],
    relationName: "packetChildren",
  }),
  children: many(documents, { relationName: "packetChildren" }),
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
  sources: many(partSources),
  classifications: many(partClassifications),
}));

export const partClassificationsRelations = relations(
  partClassifications,
  ({ one }) => ({
    part: one(parts, {
      fields: [partClassifications.partId],
      references: [parts.id],
    }),
  }),
);

export const vendorsRelations = relations(vendors, ({ many }) => ({
  partSources: many(partSources),
  purchaseOrders: many(purchaseOrders),
  quoteSheets: many(quoteSheets),
  invoices: many(invoices),
}));

export const partSourcesRelations = relations(partSources, ({ one }) => ({
  part: one(parts, {
    fields: [partSources.partId],
    references: [parts.id],
  }),
  vendor: one(vendors, {
    fields: [partSources.vendorId],
    references: [vendors.id],
  }),
}));

export const quoteSheetsRelations = relations(quoteSheets, ({ one, many }) => ({
  document: one(documents, {
    fields: [quoteSheets.documentId],
    references: [documents.id],
  }),
  vendor: one(vendors, {
    fields: [quoteSheets.vendorId],
    references: [vendors.id],
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
    revisionGroups: many(measureRevisionGroups),
  }),
);

export const measureRevisionGroupsRelations = relations(
  measureRevisionGroups,
  ({ one, many }) => ({
    announcement: one(tariffAnnouncements, {
      fields: [measureRevisionGroups.announcementId],
      references: [tariffAnnouncements.id],
    }),
    members: many(measureRevisions),
  }),
);

export const measureRevisionsRelations = relations(
  measureRevisions,
  ({ one }) => ({
    announcement: one(tariffAnnouncements, {
      fields: [measureRevisions.announcementId],
      references: [tariffAnnouncements.id],
    }),
    group: one(measureRevisionGroups, {
      fields: [measureRevisions.groupId],
      references: [measureRevisionGroups.id],
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
    vendor: one(vendors, {
      fields: [entryLineItems.vendorId],
      references: [vendors.id],
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

export const entryLinePartsRelations = relations(entryLineParts, ({ one }) => ({
  entry: one(entries, {
    fields: [entryLineParts.entryId],
    references: [entries.id],
  }),
  part: one(parts, {
    fields: [entryLineParts.partId],
    references: [parts.id],
  }),
  sourceDocument: one(documents, {
    fields: [entryLineParts.sourceDocumentId],
    references: [documents.id],
  }),
}));

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

export const analysisFindingsRelations = relations(
  analysisFindings,
  ({ one }) => ({
    entry: one(entries, {
      fields: [analysisFindings.entryId],
      references: [entries.id],
    }),
    lineItem: one(entryLineItems, {
      fields: [analysisFindings.lineItemId],
      references: [entryLineItems.id],
    }),
    run: one(analysisRuns, {
      fields: [analysisFindings.runId],
      references: [analysisRuns.id],
    }),
  }),
);

export const analysisRunsRelations = relations(analysisRuns, ({ one }) => ({
  entry: one(entries, {
    fields: [analysisRuns.entryId],
    references: [entries.id],
  }),
}));

export const integrationSourcesRelations = relations(
  integrationSources,
  ({ many }) => ({
    documents: many(documents),
  }),
);

export const agentConversationsRelations = relations(
  agentConversations,
  ({ many }) => ({
    messages: many(agentMessages),
    proposals: many(agentProposals),
  }),
);

export const agentMessagesRelations = relations(agentMessages, ({ one }) => ({
  conversation: one(agentConversations, {
    fields: [agentMessages.conversationId],
    references: [agentConversations.id],
  }),
}));

export const agentProposalsRelations = relations(
  agentProposals,
  ({ one }) => ({
    conversation: one(agentConversations, {
      fields: [agentProposals.conversationId],
      references: [agentConversations.id],
    }),
    message: one(agentMessages, {
      fields: [agentProposals.messageId],
      references: [agentMessages.id],
    }),
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
export type Vendor = typeof vendors.$inferSelect;
export type PartSource = typeof partSources.$inferSelect;
export type PartClassification = typeof partClassifications.$inferSelect;
export type QuoteSheet = typeof quoteSheets.$inferSelect;
export type QuoteLine = typeof quoteLines.$inferSelect;
export type IntegrationSource = typeof integrationSources.$inferSelect;
export type OrgRule = typeof orgRules.$inferSelect;

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type EntryInvoice = typeof entryInvoices.$inferSelect;
export type HtsCode = typeof htsCodes.$inferSelect;
export type TradeMeasure = typeof tradeMeasures.$inferSelect;
export type TradeMeasureHtsRow = typeof tradeMeasureHts.$inferSelect;
export type StackingRule = typeof stackingRules.$inferSelect;
export type EntryLineItem = typeof entryLineItems.$inferSelect;
export type EntryLineCharge = typeof entryLineCharges.$inferSelect;
export type AuditAlert = typeof auditAlerts.$inferSelect;
export type AnalysisFinding = typeof analysisFindings.$inferSelect;
export type AnalysisRun = typeof analysisRuns.$inferSelect;
export type AgentConversation = typeof agentConversations.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type AgentProposal = typeof agentProposals.$inferSelect;
export type AdcvdOrder = typeof adcvdOrders.$inferSelect;
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

export type PartStatus = Part["status"];
export type QuoteLineStatus = QuoteLine["status"];
export type IntegrationKind = IntegrationSource["kind"];
export type IntegrationStatusValue = IntegrationSource["status"];
export type DocumentTypeValue = Document["docType"];
export type DocumentStatusValue = Document["status"];
export type PacketRoleValue = NonNullable<Document["packetRole"]>;
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
export type AnalysisFindingCategoryValue = AnalysisFinding["category"];
export type AnalysisRunStatusValue = AnalysisRun["status"];
export type AnalysisRunTriggerValue = AnalysisRun["trigger"];
export type AdcvdOrderStatusValue = AdcvdOrder["status"];
