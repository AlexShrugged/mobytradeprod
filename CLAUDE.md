# CLAUDE.md

@AGENTS.md

## What This Is

**MobyTrade** — a duty-visibility platform for importers, rebuilt fresh from `../moby`
(legacy Rails reference) and `../mobynew` (architecture reference). Importers track
customs entries (top-level) with their shipments and POs down to line items, see duties
owed and refunds, manage SKUs and HTS classification, understand per-SKU landed cost, and
follow a chronological event feed of their import business. Scenario modeling comes later.

Six org-facing pages: **Entries · Variance · Parts · Events · Data · Settings**, plus a
platform-operator surface at **/admin** (tariff sync + review queue). Auth is **Clerk
(Organizations)**: `src/proxy.ts` (Next 16's middleware replacement — never create a
`middleware.ts`) default-protects every page and API route except sign-in/up and the
two cron GETs; the tenant seam in `src/lib/org.ts` resolves the session's active Clerk
org (JIT-provisioned on first sight via `src/lib/org-provisioning.ts`, keyed by
`orgs.clerk_org_id`); the super-admin seam in `src/lib/admin/` admits Clerk user ids
listed in `SUPER_ADMIN_USER_IDS`. With Clerk keys unset (local dev only — the app
refuses to boot on Vercel without them, see `src/lib/auth/config.ts`), everything runs
auth-open against the single seeded org exactly as before. Documents parse via Reducto
when `REDUCTO_API_KEY` is set, otherwise a deterministic stub processor (refused on
Vercel — every stub/secret fallback fails closed there, keyed on
`isProdRuntime()` in `src/lib/env.ts`). Broker **entry packets** (one PDF
bundling a 7501 + commercial invoice + supporting docs) split into child documents
(parent-child rows on `documents`; children share the parent's file, page-scoped) that
each run the normal per-doc pipeline.

## Customs data ingestion

The daily sync (`GET /api/tariff-sync` cron, `POST` = admin button) fetches the USITC
HTS + Federal Register and **stages, never applies**: tracked-measure Ch99 changes as
per-revision cards, untracked codes grouped into (authority, 6-digit-prefix) adoption
family cards (`tariff-sync/grouping.ts`), and each base-schedule release as ONE
reviewable unit with a diffstat + truncation guard (`tariff-sync/base-guard.ts`).
Nothing reaches the reference tables until the super admin approves it at
`/admin/tariffs`; approval + apply + all-orgs re-audit run in one transaction. The
tariff review queue is **global** (`review_items.org_id` null — a CHECK ties scope to
item type); classification review stays org-scoped. Staged create_measure proposals get
dates/countries proposed by `tariff-sync/extractor/` (Claude via `ANTHROPIC_API_KEY` +
optional `TARIFF_EXTRACTOR_MODEL`, deterministic stub otherwise; merge rules in
`extractor/merge.ts` — deterministic values win, sub-threshold confidence stays
evidence-only). `scripts/import-legacy-tariff.ts` (env `MOBY_DIR`, dry-run by default,
`--apply` to stage) bootstraps the queue from `../moby`'s hand-curated measures. Base
windows still stamped release `"SEED"` are demo approximations — the first certified
release corrects them in place instead of tiling them into history. Reference reads go
through `duty/reference.ts`: the full loader is for schedule-wide scans only
(classifier candidate pool, seed); request paths use the org-scoped loader
(`queries/reference.ts`, React `cache()` per request).

## Architecture doctrines (carried from mobynew — do not violate)

- **Derived data is never stored.** Expected charges, duty totals, refund stage, landed
  cost, the events feed, future-entry projections, and parts "pending changes" badges are
  all computed on read. Only declared facts and human decisions persist.
- **Single writer per projection.** `processing/linker.ts` owns the entry graph
  (including `entry_invoices`); `quotes/service.ts` owns quote tables + quote-sourced
  part writes; `classification/service.ts` owns the HTS projection; `audit/auditor.ts`
  owns `audit_alerts` (reconciled by stable `alert_key`; resolved/dismissed rows never
  touched); `tariff-sync/apply.ts` owns Ch99 reference rows; `tariff-sync/base-apply.ts`
  owns base-schedule windows. Both tariff writers are approval-gated: they refuse
  unless the matching review item is approved, and the sync/extractor/import paths
  write staging tables only.
- **The commercial invoice is the only document class compared against entries for
  variance** (settled 2026-08-06; rules in `audit/invoice-rules.ts`, direct links via
  `entry_invoices`). PO/shipment document comparisons were deliberately retired — PO
  scope never matched entry scope. Catalog comparisons (HTS/COO vs parts) remain: they
  check against master data, a different axis. CI money checks gate on USD (no FX) and
  on an invoice mapping to exactly one entry; comparisons are SKU-grouped
  (pairing-invariant), never per-line-paired.
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
In production (Vercel + Neon): the app uses the pooled `DATABASE_URL`; migrations and
drizzle-kit prefer `DATABASE_URL_UNPOOLED` (DDL bypasses PgBouncer), and the Vercel
build runs `db:migrate` before `next build` (vercel.json). Files live in Vercel Blob
(`src/lib/storage/blob.ts`, selected by `STORAGE_DRIVER`/`BLOB_READ_WRITE_TOKEN`);
the dropzone uploads browser→Blob directly when `NEXT_PUBLIC_STORAGE_DRIVER=blob`
(token route + register route under `src/app/api/documents/`). See `.env.example`
for the full env surface and which vars are required on Vercel.

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
  `db:migrate`, then restart it.
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
