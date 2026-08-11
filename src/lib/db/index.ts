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

import { isProdRuntime } from "@/lib/env";

import * as schema from "./schema";

// The driver-agnostic handle every domain module accepts (db or transaction).
// Generalized over the query-result HKT so the same code runs on node-postgres
// and PGlite — this one type is what makes the Postgres swap a one-file change.
export type DbClient = PgDatabase<PgQueryResultHKT, typeof schema>;

const globalForDb = globalThis as unknown as { mobytradeDb?: DbClient };

export function getDb(): DbClient {
  if (!globalForDb.mobytradeDb) {
    const url = process.env.DATABASE_URL;
    if (!url && isProdRuntime()) {
      throw new Error(
        "DATABASE_URL is unset on Vercel — refusing the embedded PGlite fallback. " +
          "Link the Neon integration or set DATABASE_URL.",
      );
    }
    globalForDb.mobytradeDb = url
      ? (drizzleNodePg(
          new Pool({
            connectionString: url,
            // Shared per warm instance (Fluid serves concurrent requests from
            // one process). Sized for: 3 client-side process calls each
            // holding a linkExtraction transaction + the sweep's 3-doc
            // concurrency + short UI queries.
            max: 10,
            // Release idle connections quickly so scaled-down instances don't
            // pin Neon pooler slots or reuse a connection severed by
            // autosuspend.
            idleTimeoutMillis: 30_000,
            // Fails fast on misconfiguration while absorbing a Neon
            // autosuspend cold resume.
            connectionTimeoutMillis: 10_000,
          }),
          {
            schema,
          },
        ) as DbClient)
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
