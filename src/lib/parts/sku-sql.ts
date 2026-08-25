// SQL mirror of normalizeSku (./sku), for matching stored raw SKU values in
// queries. Kept apart so ./sku stays dependency-free for the pure parsers.
// The two MUST compute the same key — a drift orphans lines silently.

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

export function skuKeySql(column: AnyColumn): SQL<string> {
  return sql<string>`upper(btrim(${column}))`;
}
