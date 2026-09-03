// "Used on an entry" — the ONE predicate behind the Parts page's Active
// status (filter + option counts) and the quote reconsider sweep's candidate
// set. A SKU counts as imported when any link names it:
//   - a 7501 line (entry_line_items.part_id — set only when the broker
//     printed a part number, which real ABI printouts rarely do);
//   - a broker tariff code sheet row (entry_line_parts.part_id);
//   - a commercial invoice line on an invoice attached to an entry
//     (invoice_line_items via entry_invoices) — an invoice attached to an
//     entry means the part cleared on that entry, whichever 7501 line it
//     rolled into.
// Correlated to schema.parts.id: use inside a WHERE over the parts table.
// Relative imports on purpose — reachable from tsx scripts.

import { eq, exists, or, sql, type SQL } from "drizzle-orm";

import type { DbClient } from "../db";
import * as schema from "../db/schema";

export function partUsedOnEntrySql(db: DbClient): SQL {
  return or(
    exists(
      db
        .select({ one: sql`1` })
        .from(schema.entryLineItems)
        .where(eq(schema.entryLineItems.partId, schema.parts.id)),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(schema.entryLineParts)
        .where(eq(schema.entryLineParts.partId, schema.parts.id)),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(schema.invoiceLineItems)
        .innerJoin(
          schema.entryInvoices,
          eq(schema.entryInvoices.invoiceId, schema.invoiceLineItems.invoiceId),
        )
        .where(eq(schema.invoiceLineItems.partId, schema.parts.id)),
    ),
  ) as SQL;
}
