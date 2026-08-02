// Database singleton with the one-env-var swap: DATABASE_URL set → node-postgres
// against that URL (docker-compose.yml provides a local one); unset → embedded
// PGlite at ./.pglite (zero external services). Postgres dialect either way —
// schema and migrations are identical for both drivers.
//
// Cached on globalThis (lazy Proxy) so Next.js HMR never opens the PGlite data
// directory twice or leaks pg pools.

import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Pool } from "pg";

import * as schema from "./schema";

// The driver-agnostic handle every domain module accepts (db or transaction).
// Generalized over the query-result HKT so the same code runs on node-postgres
// and PGlite — this one type is what makes the Postgres swap a one-file change.
export type DbClient = PgDatabase<PgQueryResultHKT, typeof schema>;

const globalForDb = globalThis as unknown as { mobytradeDb?: DbClient };

export function getDb(): DbClient {
  if (!globalForDb.mobytradeDb) {
    const url = process.env.DATABASE_URL;
    globalForDb.mobytradeDb = url
      ? (drizzleNodePg(new Pool({ connectionString: url }), {
          schema,
        }) as DbClient)
      : (drizzlePglite(new PGlite(process.env.PGLITE_DATA_DIR ?? "./.pglite"), {
          schema,
        }) as DbClient);
  }
  return globalForDb.mobytradeDb;
}

export const db = new Proxy({} as DbClient, {
  get(_, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export * from "./schema";
export { schema };
