# CLAUDE.md

@AGENTS.md

## What This Is

**MobyTrade** — a duty-visibility platform for importers, rebuilt fresh from `../moby`
(legacy Rails reference) and `../mobynew` (architecture reference). Importers track
customs entries (top-level) with their shipments and POs down to line items, see duties
owed and refunds, manage SKUs and HTS classification, understand per-SKU landed cost, and
follow a chronological event feed of their import business. Scenario modeling comes later.

Seven org-facing pages: **Entries · Variance · Parts · Events · Assistant · Data · Settings**, plus a
platform-operator surface at **/admin** (tariff sync + review queue). Auth is **Clerk
(Organizations)**: `src/proxy.ts` (Next 16's middleware replacement — never create a
`middleware.ts`) default-protects every page and API route except sign-in/up and the
two cron GETs; the tenant seam in `src/lib/org.ts` resolves the session's active Clerk
org (JIT-provisioned on first sight via `src/lib/org-provisioning.ts`, keyed by
`orgs.clerk_org_id`); the super-admin seam in `src/lib/admin/` admits Clerk user ids
listed in `SUPER_ADMIN_USER_IDS` plus every member of the `SUPER_ADMIN_ORG_ID` Clerk
organization (org id, never slug). With Clerk keys unset (local dev only — the app
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
`/admin/tariffs`; approval + apply + re-analysis queueing run in one transaction, and
the re-audit runs right after commit, scoped to the entries the changed codes touch
(auditor helpers `findEntriesForMeasures`/`findEntriesForHtsDigits` +
`sweepAuditsForEntries`; an all_products measure falls back to the full sweep — the
post-commit sweep is idempotent by alert_key, so a failed sweep heals instead of
rolling back an approved apply). The
tariff review queue is **global** (`review_items.org_id` null — a CHECK ties scope to
item type); classification review stays org-scoped. Staged create_measure proposals get
dates/countries proposed by `tariff-sync/extractor/` (Claude via `ANTHROPIC_API_KEY` +
optional `TARIFF_EXTRACTOR_MODEL`, deterministic stub otherwise; merge rules in
`extractor/merge.ts` — deterministic values win, sub-threshold confidence stays
evidence-only). Create_measure applies are gated three ways (`apply.ts` + `programs.ts`): null
countries need the reviewer's explicit worldwide confirmation; a same-program
overlap (same country tier + product scope + window) AUTO-SUPERSEDES on apply
(closes the old windows at eff−1, links `predecessor_id`) — the review cards
disclose the targets per line ("Supersedes …", derived on read) and the apply
response reports what closed, while a pair with provably disjoint sail windows
is no conflict at all (a sail-date cutover: both stay live, the calculator
picks one per entry) and the only fail-closed case left is a conflict starting
on or after the proposal (broken dates); and programs are proposed by
`inferProgram` (deterministic, null when unsure), reviewer-editable on the
cards. There is no "stack" choice: within one program nothing ever charges
twice, so coexistence is only ever the sail-partition case, which the
detector now recognizes itself. Exemption headings are family-linked at
apply time (`syncFamilyExemptionLinks` in apply.ts): every liability
measure in a 6-digit Ch99 family carries a copy of the family's exemption
rows, so a broker-declared $0 exception code (9903.82.01 "no alu/steel
content") satisfies the audit's missing-measure check for its family
(9903.82.02) — linkage only suppresses alerts, never changes duty math.
`scripts/repair-exemption-linkage.ts` re-establishes the invariant for
reference data staged before this existed (ran against prod 2026-08-19). `scripts/import-legacy-tariff.ts` (env `MOBY_DIR`, dry-run by default,
`--apply` to stage) bootstraps the queue from `../moby`'s hand-curated measures. Base
windows still stamped release `"SEED"` are demo approximations — the first certified
release corrects them in place instead of tiling them into history. Reference reads go
through `duty/reference.ts`: the full loader is for schedule-wide scans only
(classifier candidate pool, seed); request paths use the org-scoped loader
(`queries/reference.ts`, React `cache()` per request).

## AI analysis

The AI entry analyst (`src/lib/analysis/`) investigates one entry at a time:
Claude (`ANTHROPIC_API_KEY`, tuned by `ENTRY_ANALYST_MODEL`/`_DEADLINE_MS`/
`_MAX_ITERATIONS`) drives eight zero-IO tools over a preloaded bundle
(auditable snapshot, document extractions, catalog, AD/CVD order corpus). The
deterministic engine stays the source of truth for money math and is exposed
AS tools (get_expected_charges etc.); every finding carries verbatim evidence
citations. `analysis/service.ts` is the sole writer of `analysis_runs` +
`analysis_findings`: findings reconcile by stable finding_key
(`ai:<category>:<line>`), resolved/dismissed rows are never touched, and only
a clean Claude run reconciles — failed/degraded runs never clobber findings
and the stub never persists at all (the analyze route 503s without a key).
NOVEL findings (empty relatedAlertKeys) join the variance queue as
`ai_<category>` rows with null impact (the engine owns dollars) and reconcile
at `/variance/[id]` exactly like rule alerts (the alerts PATCH route decides
both kinds, so mixed-line review flows work); corroborations render only on
the entry page's AI card. Tariff approvals enqueue re-analysis (pending
`analysis_runs` rows, one per previously analyzed entry the changed codes
touch) inside the apply transaction and drain the queue after the response
(`after()`); with no API
key the queue stays visibly queued rather than being stub-drained.
`scripts/analyze-entry.ts` is the read-only eval harness (planted defects in
`seed-data/analysis-defects.ts` — deterministic-rule-invisible by design, the
seed asserts those entries audit clean). `scripts/hts-savings.ts` runs the
part-scoped HTS-savings analyst (`analysis/savings/`, report-only — nothing
persists). The `adcvd_orders` reference table is seed-approximated context
for the analyst, never an input to deterministic duty math. The HTS
classifier behind `classification/index.ts` is Claude-backed the same way
(pool-preselected candidates, out-of-pool codes dropped, stub fallback).

The org-facing **assistant** (`/assistant`, `src/lib/agent/`) is the
conversational surface over all of it: a streaming toolRunner turn (NDJSON
over POST, `agent/protocol.ts`) with twelve org-scoped tools — variance
queue/detail, entries, deterministic charge/measure engines, parts,
documents (incl. `read_document_text`, the first and only reader of
`documents.raw_extraction`), and `propose_actions`. The agent holds ZERO
write tools: propose_actions stages `agent_proposals` cards and the human's
Confirm executes through the EXISTING decision routes client-side (alerts
PATCH per unit id with the agent's rationale as `resolutionNote`, analyze
POST). Unit expansion (rate/amount twins via `pairSiblingAlerts`) happens
server-side at propose time; cards join live row status on read so stale
proposals render as decided-elsewhere. Tools do request-scoped IO through
the injectable `AgentToolDeps` seam (`agent/deps.ts`, server-only) — a
DELIBERATE departure from the analyst's zero-IO bundle doctrine; the pure
submodules (protocol, transcript repair/elision, document-text, markdown,
display) are vitest-covered, and `agent/claude.test.ts` drives real tools
through a scripted fake stream client. Transcripts persist as raw Anthropic
content blocks (`agent_messages`, rebuilt + repaired by `agent/transcript.ts`);
turns are locked one-per-conversation (`turnStartedAt`, stale-reclaimed);
Stop only stops rendering — the turn finishes via `after()` and
`router.refresh()` reconciles. Env: `AGENT_MODEL`/`AGENT_DEADLINE_MS`/
`AGENT_MAX_ITERATIONS`; no key → echo stub locally, 503 + banner on Vercel.

## Architecture doctrines (carried from mobynew — do not violate)

- **Derived data is never stored.** Expected charges, duty totals, refund stage, landed
  cost, the events feed, future-entry projections, and parts "pending changes" badges are
  all computed on read. Only declared facts and human decisions persist.
- **Single writer per projection.** `processing/linker.ts` owns the entry graph
  (including `entry_invoices`); `quotes/service.ts` owns quote tables + quote-sourced
  part writes; `classification/service.ts` owns the HTS projection; `audit/auditor.ts`
  owns `audit_alerts` (reconciled by stable `alert_key`; resolved/dismissed rows never
  touched); `analysis/service.ts` owns `analysis_runs` + `analysis_findings` (same
  reconcile contract, keyed by `finding_key`); `agent/service.ts` owns
  `agent_conversations` + `agent_messages` + `agent_proposals` (the assistant
  itself never writes domain rows — human-confirmed proposals execute through
  the existing decision routes); `tariff-sync/apply.ts` owns Ch99
  reference rows; `tariff-sync/base-apply.ts` owns base-schedule windows. Both tariff writers are approval-gated: they refuse
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
- **One charge per program.** `trade_measures.program` is the stable legal-program
  identity ("ieepa-reciprocal") and the calculator's exclusivity key: at most one
  measure per program applies to a line (country-specific headings beat the worldwide
  baseline, then costlier rate; losers surface as suppressed). Distinct programs stack
  even under one statute (CBP filed 301 + IEEPA fentanyl + IEEPA reciprocal on ONE
  line), so `authority` is a display bucket, never the exclusivity key. Null program =
  lineage unknown: never deduped — sync-created measures stay null until a human
  assigns the program.
- **MPF/HMF are ingested facts** on entries — never computed (CBP per-entry mins/caps).
  Nominal rates appear only in estimates, labeled as such.
- **Catalog import overwrites, for now.** The Parts page CSV/XLSX import
  (`parts/import-service.ts`; upload filed as a processed `part_catalog` document on
  the Data page) last-write-wins over existing SKUs — right for the launch use case of
  seeding an empty catalog, wrong once catalogs are live and a difference means "which
  one is correct?". Future: SKU-level conflict resolution that stages differences for
  human review instead of overwriting. Every overwrite records `field_changes` with
  source `catalog_import`, so the history to build that on already exists.

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
- **Clerk dev→production instance cutover** (we launched on dev-instance keys): a
  production instance starts EMPTY and mints new `org_`/`user_` ids. Recreate orgs and
  re-invite users in the prod instance, then — before anyone signs in — remap each
  tenant row (`UPDATE orgs SET clerk_org_id = '<prod org id>' WHERE clerk_org_id =
  '<dev org id>'`) or the JIT provisioner will mint a fresh empty tenant and orphan the
  existing data. Also update `SUPER_ADMIN_USER_IDS` (user ids change too) and swap the
  two Clerk keys in Vercel.
