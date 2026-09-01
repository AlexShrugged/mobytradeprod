// The sole writer to audit_alerts. Reconciles by alert_key: new findings are
// inserted open, open rows are refreshed or deleted as conditions change,
// and resolved/dismissed rows are never touched — a human's judgment
// outlives re-ingestion.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import { and, eq, inArray, like, or } from "drizzle-orm";

import * as schema from "../db/schema";
import type { OrgRule } from "../db/schema";
import { loadReferenceDataForOrg, type DbClient } from "../duty/reference";
import { resolveSailInfo } from "../duty/sail";
import type { ReferenceData } from "../duty/types";
import { resolveWindow } from "../effective-dating";
import { activeSuppressionRules, loadOrgRules } from "../org-rules";
import { computeEntryAlerts, type AuditableEntry } from "./rules";
import { applySuppressions } from "./suppression";

/** Per-vendor as-of resolution of a part's sourcing windows: for each
 *  vendor, the window containing the entry date wins, falling back to the
 *  vendor's current window (pre-window entries keep today's expectation,
 *  exactly as before windowing existed). A vendor with no containing and no
 *  current window — removed before the entry, or added after with no open
 *  row — drops out entirely. */
function resolveSourcesAsOf(
  sources: (schema.PartSource & { vendor: schema.Vendor })[],
  entryDate: string | null,
): { vendorId: string; vendorName: string; countryOfOrigin: string | null }[] {
  const byVendor = new Map<string, typeof sources>();
  for (const s of sources) {
    const rows = byVendor.get(s.vendorId);
    if (rows) rows.push(s);
    else byVendor.set(s.vendorId, [s]);
  }
  const resolved = [];
  for (const rows of byVendor.values()) {
    const hit = resolveWindow(rows, entryDate);
    if (hit) {
      resolved.push({
        vendorId: hit.vendorId,
        vendorName: hit.vendor.name,
        countryOfOrigin: hit.countryOfOrigin,
      });
    }
  }
  return resolved;
}

/** Key-order-insensitive deep equality for alert details. jsonb round-trips
 *  do not preserve key order, so a raw JSON.stringify comparison would
 *  spuriously mismatch and rewrite every open row on every audit. */
function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const record = v as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",");
  return `{${body}}`;
}

const detailsEqual = (a: unknown, b: unknown): boolean =>
  stableStringify(a ?? null) === stableStringify(b ?? null);

/** The entry header facts alongside the rule-ready snapshot — what a reader
 *  needs to reason about the entry beyond the rules' inputs (type 03 flags
 *  AD/CVD, MPF/HMF are ingested facts the rules deliberately skip). */
export type AuditableSnapshot = {
  entry: {
    id: string;
    entryNumber: string;
    entryDate: string | null;
    entryType: string | null;
    portOfEntry: string | null;
    importerOfRecord: string | null;
    totalEnteredValue: string | null;
    totalDuty: string | null;
    totalBaseDuty: string | null;
    mpfAmount: string | null;
    hmfAmount: string | null;
  };
  auditable: AuditableEntry;
};

/** Build the exact snapshot the auditor rules run against — exported so the
 *  entry analyst reads byte-identical facts to a production audit. Read-only:
 *  the auditor below remains the sole writer to audit_alerts. */
export async function loadAuditableSnapshot(
  db: DbClient,
  orgId: string,
  entryId: string,
): Promise<AuditableSnapshot | null> {
  const entry = await db.query.entries.findFirst({
    where: and(
      eq(schema.entries.id, entryId),
      eq(schema.entries.orgId, orgId),
    ),
    with: {
      lineItems: {
        with: {
          // Sources and classifications are deliberately loaded WITHOUT a
          // current-window filter: the auditor is the one reader that
          // resolves windows as of the entry date.
          part: {
            with: {
              sources: { with: { vendor: true } },
              classifications: true,
            },
          },
          charges: true,
        },
        orderBy: (li, { asc }) => [asc(li.lineNumber)],
      },
      entryShipments: { with: { shipment: true } },
    },
  });
  if (!entry) return null;

  // Rule 16's gate: any part at all makes the catalog axis live.
  const anyPart = await db.query.parts.findFirst({
    where: eq(schema.parts.orgId, orgId),
    columns: { id: true },
  });

  const auditable: AuditableEntry = {
    entryDate: entry.entryDate,
    orgHasCatalog: anyPart !== undefined,
    totalEnteredValue: entry.totalEnteredValue,
    totalDuty: entry.totalDuty,
    sail: resolveSailInfo(entry.entryShipments.map((es) => es.shipment)),
    lines: entry.lineItems.map((li) => ({
      id: li.id,
      lineNumber: li.lineNumber,
      sku: li.sku,
      partId: li.partId,
      htsCode: li.htsCode,
      htsCodeDigits: li.htsCodeDigits,
      spi: li.spi,
      countryOfOrigin: li.countryOfOrigin,
      vendorId: li.vendorId,
      enteredValue: li.enteredValue,
      quantity: li.quantity,
      description: li.description,
      supplierName: li.supplierName,
      // Classification windows hold committed codes only (provisional codes
      // never create one), resolved AS OF the entry date so historical
      // entries audit against the code of their day; undated entries and
      // entries predating every window fall back to the current window.
      // Draft parts (quote-created, not yet official) are guarded out:
      // nothing on a draft part is a committed fact.
      partHtsCode:
        li.part && li.part.status !== "draft"
          ? (resolveWindow(li.part.classifications, entry.entryDate)?.htsCode ??
            null)
          : null,
      // Today's opinion, for the reclassified-after-filing signal.
      partHtsCodeCurrent:
        li.part && li.part.status !== "draft"
          ? (li.part.classifications.find((c) => c.validTo === null)?.htsCode ??
            null)
          : null,
      partHtsCurrentSince:
        li.part && li.part.status !== "draft"
          ? (li.part.classifications.find((c) => c.validTo === null)
              ?.validFrom ?? null)
          : null,
      // Sourcing facts resolved per vendor as of the entry date. A vendor
      // whose windows are all closed before (or opened after) the entry date
      // drops out — a removed source stops constraining later entries but
      // still constrains in-window ones. Same draft guard: a draft part's
      // sourcing rows are quote claims, not committed facts.
      partSources:
        li.part && li.part.status !== "draft"
          ? resolveSourcesAsOf(li.part.sources, entry.entryDate)
          : [],
      charges: li.charges.map((c) => ({
        id: c.id,
        chargeType: c.chargeType,
        htsCode: c.htsCode,
        htsCodeDigits: c.htsCodeDigits,
        rate: c.rate,
        amount: c.amount,
      })),
    })),
    linkedInvoices: [],
  };

  // Invoices link DIRECTLY via entry_invoices (written by the linker's
  // packet/reference/PO-fallback passes) — the via-PO load was retired when
  // CIs became the primary variance source (PO scope never matched entry
  // scope). linkedEntryCount feeds the single-entry applicability gate.
  const invoiceLinks = await db.query.entryInvoices.findMany({
    where: eq(schema.entryInvoices.entryId, entryId),
    with: {
      invoice: {
        with: {
          lineItems: { orderBy: (li, { asc }) => [asc(li.lineNumber)] },
          adjustments: { orderBy: (a, { asc }) => [asc(a.position)] },
        },
      },
    },
  });
  if (invoiceLinks.length > 0) {
    const invoiceIds = invoiceLinks.map((l) => l.invoiceId);
    const allLinks = await db.query.entryInvoices.findMany({
      where: inArray(schema.entryInvoices.invoiceId, invoiceIds),
      columns: { invoiceId: true },
    });
    const entryCount = new Map<string, number>();
    for (const l of allLinks)
      entryCount.set(l.invoiceId, (entryCount.get(l.invoiceId) ?? 0) + 1);
    auditable.linkedInvoices = invoiceLinks
      .map(({ invoice }) => ({
        invoiceNumber: invoice.invoiceNumber,
        currency: invoice.currency,
        totalAmount: invoice.totalAmount,
        subtotal: invoice.subtotal,
        adjustments: invoice.adjustments.map((a) => ({
          label: a.label,
          amount: a.amount,
        })),
        lines: invoice.lineItems.map((li) => ({
          sku: li.sku,
          htsCode: li.htsCode,
          htsCodeDigits: li.htsCodeDigits,
          countryOfOrigin: li.countryOfOrigin,
          quantity: li.quantity,
          totalPrice: li.totalPrice,
        })),
        linkedEntryCount: entryCount.get(invoice.id) ?? 1,
      }))
      .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
  }

  return {
    entry: {
      id: entry.id,
      entryNumber: entry.entryNumber,
      entryDate: entry.entryDate,
      entryType: entry.entryType,
      portOfEntry: entry.portOfEntry,
      importerOfRecord: entry.importerOfRecord,
      totalEnteredValue: entry.totalEnteredValue,
      totalDuty: entry.totalDuty,
      totalBaseDuty: entry.totalBaseDuty,
      mpfAmount: entry.mpfAmount,
      hmfAmount: entry.hmfAmount,
    },
    auditable,
  };
}

export async function auditEntry(
  db: DbClient,
  orgId: string,
  entryId: string,
  // Sweeps re-auditing many entries pass one preloaded ReferenceData so the
  // reference tables aren't re-read per entry.
  preloadedRef?: ReferenceData,
  // Same shape for org rules: sweeps preload once per org.
  preloadedRules?: OrgRule[],
): Promise<void> {
  const snapshot = await loadAuditableSnapshot(db, orgId, entryId);
  if (!snapshot) return;

  const ref = preloadedRef ?? (await loadReferenceDataForOrg(db, orgId));
  const computed = computeEntryAlerts(snapshot.auditable, ref);
  // Org suppression rules filter the desired set BEFORE reconcile, so
  // suppressed alerts behave like disappeared conditions: open rows delete
  // as stale, resolved/dismissed rows are never touched, and disabling a
  // rule re-inserts on the next audit. Duty math is untouched.
  const orgRules = preloadedRules ?? (await loadOrgRules(db, orgId));
  const { kept: desired } = applySuppressions(
    computed,
    snapshot.auditable,
    activeSuppressionRules(orgRules),
  );

  const existing = await db.query.auditAlerts.findMany({
    where: eq(schema.auditAlerts.entryId, entryId),
  });
  const existingByKey = new Map(existing.map((a) => [a.alertKey, a]));
  const desiredKeys = new Set(desired.map((d) => d.alertKey));

  const toInsert = desired.filter((d) => !existingByKey.has(d.alertKey));
  if (toInsert.length > 0) {
    await db
      .insert(schema.auditAlerts)
      .values(toInsert.map((d) => ({ orgId, entryId, ...d })));
  }

  for (const d of desired) {
    const ex = existingByKey.get(d.alertKey);
    if (!ex || ex.status !== "open") continue;
    const unchanged =
      ex.alertType === d.alertType &&
      ex.severity === d.severity &&
      ex.label === d.label &&
      ex.message === d.message &&
      ex.lineItemId === d.lineItemId &&
      // Details drift too (e.g. a retroactive window change moves the
      // expected amount) — refresh open rows so the persisted snapshot
      // matches the live expectation.
      detailsEqual(ex.details, d.details);
    if (unchanged) continue;
    await db
      .update(schema.auditAlerts)
      .set({
        alertType: d.alertType,
        severity: d.severity,
        label: d.label,
        message: d.message,
        details: d.details,
        lineItemId: d.lineItemId,
        updatedAt: new Date(),
      })
      .where(eq(schema.auditAlerts.id, ex.id));
  }

  const staleIds = existing
    .filter((a) => a.status === "open" && !desiredKeys.has(a.alertKey))
    .map((a) => a.id);
  if (staleIds.length > 0) {
    await db
      .delete(schema.auditAlerts)
      .where(inArray(schema.auditAlerts.id, staleIds));
  }
}

export type ReauditSummary = {
  entries: number;
  cleared: number; // open findings that disappeared
  created: number; // open findings that newly appeared
};

/**
 * Re-audit every entry carrying a line linked to this part — the follow-up
 * to a catalog HTS correction. Clearing a discrepancy re-enables the money
 * checks on those lines, so corrections can legitimately CREATE findings;
 * the summary lets the UI present that as intended behavior.
 */
export async function reauditEntriesForPart(
  db: DbClient,
  orgId: string,
  partId: string,
): Promise<ReauditSummary> {
  const rows = await db
    .selectDistinct({ entryId: schema.entryLineItems.entryId })
    .from(schema.entryLineItems)
    .where(
      and(
        eq(schema.entryLineItems.orgId, orgId),
        eq(schema.entryLineItems.partId, partId),
      ),
    );

  const orgRules = await loadOrgRules(db, orgId);
  let cleared = 0;
  let created = 0;
  for (const { entryId } of rows) {
    const before = await openKeys(db, entryId);
    await auditEntry(db, orgId, entryId, undefined, orgRules);
    const after = await openKeys(db, entryId);
    for (const key of before) if (!after.has(key)) cleared += 1;
    for (const key of after) if (!before.has(key)) created += 1;
  }
  return { entries: rows.length, cleared, created };
}

/**
 * Re-audit every entry in the org — the follow-up to applying a tariff
 * announcement (expected charges are derived on read, but audit alerts
 * persist and must be re-derived). Loads reference data once. Synchronous
 * at current scale; the missing background-job runner (ROADMAP) is the
 * scale-out seam.
 */
export async function sweepAudits(
  db: DbClient,
  orgId: string,
): Promise<ReauditSummary> {
  const ref = await loadReferenceDataForOrg(db, orgId);
  const orgRules = await loadOrgRules(db, orgId);
  const rows = await db.query.entries.findMany({
    where: eq(schema.entries.orgId, orgId),
    columns: { id: true },
  });

  let cleared = 0;
  let created = 0;
  for (const { id } of rows) {
    const before = await openKeys(db, id);
    await auditEntry(db, orgId, id, ref, orgRules);
    const after = await openKeys(db, id);
    for (const key of before) if (!after.has(key)) cleared += 1;
    for (const key of after) if (!before.has(key)) created += 1;
  }
  return { entries: rows.length, cleared, created };
}

/**
 * Re-audit every entry in every org — the follow-up to applying a GLOBAL
 * reference change (a tariff revision, group, or base release affects all
 * tenants at once). v1 has one org; this loop is the multi-tenant seam.
 */
export async function sweepAuditsAllOrgs(db: DbClient): Promise<ReauditSummary> {
  const orgs = await db.query.orgs.findMany({ columns: { id: true } });
  const total: ReauditSummary = { entries: 0, cleared: 0, created: 0 };
  for (const { id } of orgs) {
    const summary = await sweepAudits(db, id);
    total.entries += summary.entries;
    total.cleared += summary.cleared;
    total.created += summary.created;
  }
  return total;
}

/** One entry a tariff change touches — the unit of a scoped sweep. */
export type SweepTarget = { orgId: string; entryId: string };

/** Entries (every org — reference data is global) declaring a line whose
 *  HTS digits fall under any of these measure prefixes: the blast radius
 *  of a Ch99 change. Prefixes are digit strings, same form the calculator
 *  matches with startsWith. */
export async function findEntriesForHtsPrefixes(
  db: DbClient,
  prefixes: string[],
): Promise<SweepTarget[]> {
  const unique = [...new Set(prefixes)];
  const targets = new Map<string, SweepTarget>();
  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200);
    const rows = await db
      .selectDistinct({
        orgId: schema.entryLineItems.orgId,
        entryId: schema.entryLineItems.entryId,
      })
      .from(schema.entryLineItems)
      .where(
        or(
          ...batch.map((p) =>
            like(schema.entryLineItems.htsCodeDigits, `${p}%`),
          ),
        ),
      );
    for (const r of rows) targets.set(r.entryId, r);
  }
  return [...targets.values()];
}

/** Entries declaring a line whose digits exactly match a touched base
 *  code. Exact match suffices for base releases: rate inheritance means a
 *  subheading change surfaces on every inheriting 10-digit leaf as its own
 *  changed row, so declared leaf codes are always in the touched set. */
export async function findEntriesForHtsDigits(
  db: DbClient,
  digits: string[],
): Promise<SweepTarget[]> {
  const unique = [...new Set(digits)];
  const targets = new Map<string, SweepTarget>();
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const rows = await db
      .selectDistinct({
        orgId: schema.entryLineItems.orgId,
        entryId: schema.entryLineItems.entryId,
      })
      .from(schema.entryLineItems)
      .where(inArray(schema.entryLineItems.htsCodeDigits, batch));
    for (const r of rows) targets.set(r.entryId, r);
  }
  return [...targets.values()];
}

/** The touched-entry set for a list of changed/ended Ch99 measures.
 *  Returns null when the change cannot be scoped — an all_products measure
 *  reaches every line — and the caller must fall back to a full sweep. An
 *  empty measure list means nothing changed: empty set, not a full sweep.
 *  extraPrefixes folds in the proposal's own prefix list as a safety
 *  superset (covers a scope narrowed by the apply). */
export async function findEntriesForMeasures(
  db: DbClient,
  measureIds: string[],
  extraPrefixes: string[] = [],
): Promise<SweepTarget[] | null> {
  const ids = [...new Set(measureIds)];
  if (ids.length === 0) return [];
  const measures = await db.query.tradeMeasures.findMany({
    where: inArray(schema.tradeMeasures.id, ids),
    columns: { scope: true },
  });
  if (measures.some((m) => m.scope === "all_products")) return null;
  const prefixRows = await db.query.tradeMeasureHts.findMany({
    where: inArray(schema.tradeMeasureHts.tradeMeasureId, ids),
    columns: { htsPrefix: true },
  });
  return findEntriesForHtsPrefixes(db, [
    ...prefixRows.map((r) => r.htsPrefix),
    ...extraPrefixes,
  ]);
}

/** Re-audit exactly these entries, loading reference data once per org —
 *  the scoped follow-up to a tariff apply. Runs AFTER the apply transaction
 *  commits: the auditor reconciles idempotently by alert_key, so a sweep
 *  that dies part-way leaves stale-but-valid alerts that the next sweep
 *  heals, never a torn apply. */
export async function sweepAuditsForEntries(
  db: DbClient,
  targets: SweepTarget[],
): Promise<ReauditSummary> {
  const byOrg = new Map<string, string[]>();
  for (const t of targets) {
    const list = byOrg.get(t.orgId);
    if (list) list.push(t.entryId);
    else byOrg.set(t.orgId, [t.entryId]);
  }
  let cleared = 0;
  let created = 0;
  for (const [orgId, entryIds] of byOrg) {
    const ref = await loadReferenceDataForOrg(db, orgId);
    const orgRules = await loadOrgRules(db, orgId);
    for (const entryId of entryIds) {
      const before = await openKeys(db, entryId);
      await auditEntry(db, orgId, entryId, ref, orgRules);
      const after = await openKeys(db, entryId);
      for (const key of before) if (!after.has(key)) cleared += 1;
      for (const key of after) if (!before.has(key)) created += 1;
    }
  }
  return { entries: targets.length, cleared, created };
}

async function openKeys(db: DbClient, entryId: string): Promise<Set<string>> {
  const rows = await db.query.auditAlerts.findMany({
    where: and(
      eq(schema.auditAlerts.entryId, entryId),
      eq(schema.auditAlerts.status, "open"),
    ),
    columns: { alertKey: true },
  });
  return new Set(rows.map((r) => r.alertKey));
}
