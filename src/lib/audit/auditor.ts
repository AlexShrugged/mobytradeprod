// The sole writer to audit_alerts. Reconciles by alert_key: new findings are
// inserted open, open rows are refreshed or deleted as conditions change,
// and resolved/dismissed rows are never touched — a human's judgment
// outlives re-ingestion.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import { and, eq, inArray } from "drizzle-orm";

import * as schema from "../db/schema";
import { loadReferenceData, type DbClient } from "../duty/reference";
import { resolveSailInfo } from "../duty/sail";
import type { ReferenceData } from "../duty/types";
import { computeEntryAlerts, type AuditableEntry } from "./rules";

export async function auditEntry(
  db: DbClient,
  orgId: string,
  entryId: string,
  // Sweeps re-auditing many entries pass one preloaded ReferenceData so the
  // reference tables aren't re-read per entry.
  preloadedRef?: ReferenceData,
): Promise<void> {
  const entry = await db.query.entries.findFirst({
    where: and(
      eq(schema.entries.id, entryId),
      eq(schema.entries.orgId, orgId),
    ),
    with: {
      lineItems: {
        with: { part: true, charges: true },
        orderBy: (li, { asc }) => [asc(li.lineNumber)],
      },
      entryPurchaseOrders: { with: { purchaseOrder: true } },
      entryShipments: { with: { shipment: true } },
    },
  });
  if (!entry) return;

  const ref = preloadedRef ?? (await loadReferenceData(db));
  const auditable: AuditableEntry = {
    entryDate: entry.entryDate,
    totalEnteredValue: entry.totalEnteredValue,
    totalDuty: entry.totalDuty,
    sail: resolveSailInfo(entry.entryShipments.map((es) => es.shipment)),
    lines: entry.lineItems.map((li) => ({
      id: li.id,
      lineNumber: li.lineNumber,
      sku: li.sku,
      htsCode: li.htsCode,
      htsCodeDigits: li.htsCodeDigits,
      countryOfOrigin: li.countryOfOrigin,
      enteredValue: li.enteredValue,
      // A provisional (classifier-auto-selected, unreviewed) catalog code
      // must never drive compliance findings — only committed codes count.
      // Draft parts (quote-created, not yet official) are the same story:
      // nothing on a draft part is a committed fact, so its code is treated
      // as absent too.
      partHtsCode:
        li.part && !li.part.htsCodeProvisional && li.part.status !== "draft"
          ? li.part.htsCode
          : null,
      charges: li.charges.map((c) => ({
        id: c.id,
        chargeType: c.chargeType,
        htsCode: c.htsCode,
        htsCodeDigits: c.htsCodeDigits,
        rate: c.rate,
        amount: c.amount,
      })),
    })),
    linkedPos: entry.entryPurchaseOrders.map((epo) => ({
      poNumber: epo.purchaseOrder.poNumber,
      totalAmount: epo.purchaseOrder.totalAmount,
    })),
    linkedInvoices: [],
  };

  // Invoices reach an entry through its POs (no direct link exists).
  const poIds = entry.entryPurchaseOrders.map((epo) => epo.purchaseOrderId);
  if (poIds.length > 0) {
    const invoiceRows = await db.query.invoices.findMany({
      where: and(
        eq(schema.invoices.orgId, orgId),
        inArray(schema.invoices.purchaseOrderId, poIds),
      ),
      with: { lineItems: { columns: { totalPrice: true } } },
    });
    auditable.linkedInvoices = invoiceRows.map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      totalAmount: inv.totalAmount,
      lineTotalSum: inv.lineItems
        .reduce((sum, li) => sum + Number(li.totalPrice), 0)
        .toFixed(2),
      lineCount: inv.lineItems.length,
    }));
  }

  const desired = computeEntryAlerts(auditable, ref);

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
      ex.lineItemId === d.lineItemId;
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

  let cleared = 0;
  let created = 0;
  for (const { entryId } of rows) {
    const before = await openKeys(db, entryId);
    await auditEntry(db, orgId, entryId);
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
  const ref = await loadReferenceData(db);
  const rows = await db.query.entries.findMany({
    where: eq(schema.entries.orgId, orgId),
    columns: { id: true },
  });

  let cleared = 0;
  let created = 0;
  for (const { id } of rows) {
    const before = await openKeys(db, id);
    await auditEntry(db, orgId, id, ref);
    const after = await openKeys(db, id);
    for (const key of before) if (!after.has(key)) cleared += 1;
    for (const key of after) if (!before.has(key)) created += 1;
  }
  return { entries: rows.length, cleared, created };
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
