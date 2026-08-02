# CLAUDE.md

@AGENTS.md

## What This Is

**MobyTrade** — a duty-visibility platform for importers, rebuilt fresh from `../moby`
(legacy Rails reference) and `../mobynew` (architecture reference). Importers track
customs entries (top-level) with their shipments and POs down to line items, see duties
owed and refunds, manage SKUs and HTS classification, understand per-SKU landed cost, and
follow a chronological event feed of their import business. Scenario modeling comes later.

Five pages: **Entries · Parts · Events · Data · Settings**. No auth yet (single seeded
org, seam in `src/lib/org.ts`). Documents parse via Reducto when `REDUCTO_API_KEY` is
set, otherwise a deterministic stub processor.

## Architecture doctrines (carried from mobynew — do not violate)

- **Derived data is never stored.** Expected charges, duty totals, refund stage, landed
  cost, the events feed, future-entry projections, and parts "pending changes" badges are
  all computed on read. Only declared facts and human decisions persist.
- **Single writer per projection.** `processing/linker.ts` owns the entry graph;
  `quotes/service.ts` owns quote tables + quote-sourced part writes;
  `classification/service.ts` owns the HTS projection; `audit/auditor.ts` owns
  `audit_alerts` (reconciled by stable `alert_key`; resolved/dismissed rows never touched);
  `tariff-sync/apply.ts` owns Ch99 reference rows; `tariff-sync/base-apply.ts` owns
  base-schedule windows.
- **Pure calculators**: integer cents, decimal-fraction rates, no IO; db handle passed as
  a parameter (`DbClient`). Tests colocated (`*.test.ts`).
- **MPF/HMF are ingested facts** on entries — never computed (CBP per-entry mins/caps).
  Nominal rates appear only in estimates, labeled as such.

## Database

Drizzle ORM, Postgres dialect everywhere. **One-env-var swap**: `DATABASE_URL` unset →
embedded PGlite at `./.pglite`; set → node-postgres against that URL
(`docker-compose up -d` provides a local Postgres at
`postgres://mobytrade:mobytrade@localhost:5434/mobytrade`). Schema and migrations are
identical for both. The branch lives in `src/lib/db/index.ts` + `drizzle.config.ts`.

## Commands

```bash
npm run dev          # dev server (3000, or next free port — check the output)
npm run build        # production build
npm run lint         # eslint
npm run check-types  # tsc --noEmit
npm test             # vitest (pure lib logic)
npm run db:generate  # drizzle-kit generate (after editing src/lib/db/schema.ts)
npm run db:migrate   # apply migrations
npm run db:seed      # deterministic demo data (e-bike importer, dates relative to today)
npm run db:reset     # wipe .pglite, re-migrate, re-seed
```

## Known Patterns & Gotchas

- **PGlite is single-process.** Stop the dev server before `db:seed` / `db:reset` /
  `db:migrate`, then restart it (it also caches the org id — restart after reseeding).
- **`serverExternalPackages: ["@electric-sql/pglite"]`** in `next.config.ts` is required —
  bundling PGlite breaks its WASM loading.
- Global npm config has `ignore-scripts` on — if a native/WASM dep misbehaves, rebuild
  with `npm rebuild --ignore-scripts=false`.
- Pages are async RSCs with `export const dynamic = "force-dynamic"` and a sibling
  `loading.tsx`. Reads go through `src/lib/db/queries/*` (`import "server-only"`).
  Mutations are route handlers under `src/app/api/**` with zod-parsed bodies; client
  components mutate via `fetch()` + `router.refresh()`. No server actions, no react-query.
- tsx scripts run as CJS — no top-level await; wrap in `main()`.
- Seed dates are relative to seed day so the demo (including the sail-tiled Section 122
  measure pair) never goes stale.
