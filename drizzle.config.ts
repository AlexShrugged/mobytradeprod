import { defineConfig } from "drizzle-kit";

// One-env-var database swap: with DATABASE_URL set, drizzle-kit targets that Postgres
// (docker-compose.yml provides one); unset, it targets embedded PGlite at ./.pglite.
// Dialect is postgresql either way — schema and migrations are identical for both.
const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  ...(url
    ? { dbCredentials: { url } }
    : { driver: "pglite", dbCredentials: { url: "./.pglite" } }),
});
