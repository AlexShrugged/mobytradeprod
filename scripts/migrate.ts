// Applies drizzle/migrations to whichever database DATABASE_URL selects:
// set → that Postgres; unset → local PGlite at ./.pglite.
// Run via `npm run db:migrate`. (tsx runs this as CJS — no top-level await.)
//
// DDL + the migrator's advisory lock belong on Neon's direct endpoint, not
// through PgBouncer — prefer DATABASE_URL_UNPOOLED when the integration
// provides it.

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url && process.env.VERCEL === "1") {
    throw new Error(
      "No DATABASE_URL(_UNPOOLED) on Vercel — refusing the PGlite migration fallback.",
    );
  }
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new Pool({ connectionString: url });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    await pool.end();
    console.log(`Migrations applied to ${url.replace(/:[^:@/]+@/, ":***@")}`);
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite("./.pglite");
    await migrate(drizzle(client), { migrationsFolder: "./drizzle/migrations" });
    await client.close();
    console.log("Migrations applied to ./.pglite");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
