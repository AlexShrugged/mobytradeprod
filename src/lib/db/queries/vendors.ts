import "server-only";

import { and, asc, count, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

// The Settings vendor card payload: every vendor with how much of the org's
// world hangs off it — part sources plus the documents that resolve to it.
// Counts are derived on read (one grouped query per table, merged in code),
// mirroring the parallel-reads pattern of the other query modules.

export type VendorRow = {
  id: string;
  name: string;
  sourceCount: number;
  poCount: number;
  quoteSheetCount: number;
  invoiceCount: number;
};

export async function getVendors(): Promise<VendorRow[]> {
  const orgId = await getCurrentOrgId();

  const [vendors, sourceCounts, poCounts, sheetCounts, invoiceCounts] =
    await Promise.all([
      db.query.vendors.findMany({
        where: eq(schema.vendors.orgId, orgId),
        orderBy: asc(schema.vendors.name),
        columns: { id: true, name: true },
      }),
      db
        .select({ vendorId: schema.partSources.vendorId, n: count() })
        .from(schema.partSources)
        .where(
          and(
            eq(schema.partSources.orgId, orgId),
            isNull(schema.partSources.validTo),
          ),
        )
        .groupBy(schema.partSources.vendorId),
      db
        .select({ vendorId: schema.purchaseOrders.vendorId, n: count() })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.orgId, orgId))
        .groupBy(schema.purchaseOrders.vendorId),
      db
        .select({ vendorId: schema.quoteSheets.vendorId, n: count() })
        .from(schema.quoteSheets)
        .where(eq(schema.quoteSheets.orgId, orgId))
        .groupBy(schema.quoteSheets.vendorId),
      db
        .select({ vendorId: schema.invoices.vendorId, n: count() })
        .from(schema.invoices)
        .where(eq(schema.invoices.orgId, orgId))
        .groupBy(schema.invoices.vendorId),
    ]);

  const toMap = (rows: { vendorId: string | null; n: number }[]) =>
    new Map(
      rows
        .filter((r): r is { vendorId: string; n: number } => r.vendorId !== null)
        .map((r) => [r.vendorId, r.n]),
    );
  const sources = toMap(sourceCounts);
  const pos = toMap(poCounts);
  const sheets = toMap(sheetCounts);
  const invoices = toMap(invoiceCounts);

  return vendors.map((v) => ({
    id: v.id,
    name: v.name,
    sourceCount: sources.get(v.id) ?? 0,
    poCount: pos.get(v.id) ?? 0,
    quoteSheetCount: sheets.get(v.id) ?? 0,
    invoiceCount: invoices.get(v.id) ?? 0,
  }));
}
