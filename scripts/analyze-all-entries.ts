// Run the AI entry analyst over every entry that has never had a clean run,
// persisting through runEntryAnalysis — the exact path behind the entry
// page's Analyze button — so findings land in analysis_findings and novel
// diffs join the Variance queue. Analysis is opt-in per entry by design
// (each run is a real Opus investigation: minutes and dollars); this script
// is the deliberate bulk opt-in.
//
// Dry-run by default: lists the targets and exits.
//
//   DATABASE_URL=... ANTHROPIC_API_KEY=... npx tsx scripts/analyze-all-entries.ts
//   ... --run                  # execute
//   ... --run --concurrency 3  # parallel investigations (default 3)
//   ... --run --org <orgId>    # one org only
//   ... --run --limit N        # cap this pass
//   ... --run --queued         # also drain entries with a pending queue row
//   ... --run --force          # re-run entries that already have a clean run
//
// Skips entries with a run that is still "running" and younger than
// STALE_RUNNING_MS (an in-flight Vercel drain); older running rows are
// treated as abandoned and the entry is re-run. Env: ENTRY_ANALYST_MODEL,
// ENTRY_ANALYST_DEADLINE_MS, ENTRY_ANALYST_MAX_ITERATIONS tune the analyst.
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { asc, eq } from "drizzle-orm";

// Relative imports on purpose: tsx does not resolve the `@/` alias here.
import {
  failAbandonedRuns,
  runEntryAnalysis,
} from "../src/lib/analysis/service";
import { db, schema } from "../src/lib/db";

const STALE_RUNNING_MS = 20 * 60 * 1000;

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function option(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

type Target = {
  id: string;
  orgId: string;
  entryNumber: string;
  reason: "never" | "queued" | "stale_running" | "force";
};

async function main() {
  const run = flag("--run");
  const force = flag("--force");
  const queued = flag("--queued");
  const orgFilter = option("--org");
  const concurrency = Math.max(1, Number(option("--concurrency") ?? 3));
  const limit = Number(option("--limit") ?? Infinity);

  const entries = await db.query.entries.findMany({
    where: orgFilter ? eq(schema.entries.orgId, orgFilter) : undefined,
    columns: { id: true, orgId: true, entryNumber: true, entryDate: true },
    orderBy: [asc(schema.entries.entryDate), asc(schema.entries.entryNumber)],
  });
  const runs = await db.query.analysisRuns.findMany({
    columns: { entryId: true, status: true, startedAt: true },
  });

  const succeeded = new Set<string>();
  const pending = new Set<string>();
  const liveRunning = new Set<string>();
  const staleRunning = new Set<string>();
  const now = Date.now();
  for (const r of runs) {
    if (r.status === "succeeded") succeeded.add(r.entryId);
    else if (r.status === "pending") pending.add(r.entryId);
    else if (r.status === "running") {
      const age = now - (r.startedAt?.getTime() ?? 0);
      (age < STALE_RUNNING_MS ? liveRunning : staleRunning).add(r.entryId);
    }
  }

  const targets: Target[] = [];
  for (const e of entries) {
    if (liveRunning.has(e.id)) continue;
    let reason: Target["reason"] | null = null;
    if (!succeeded.has(e.id)) reason = "never";
    else if (staleRunning.has(e.id)) reason = "stale_running";
    else if (queued && pending.has(e.id)) reason = "queued";
    else if (force) reason = "force";
    if (reason) targets.push({ ...e, reason });
  }
  const skippedLive = entries.filter((e) => liveRunning.has(e.id)).length;
  const selected = targets.slice(0, limit);

  console.log(
    `${entries.length} entries${orgFilter ? ` in org ${orgFilter}` : ""}: ` +
      `${succeeded.size} analyzed, ${pending.size} queued, ` +
      `${liveRunning.size} running live, ${staleRunning.size} running stale.`,
  );
  console.log(
    `${selected.length} target(s)` +
      (targets.length > selected.length ? ` (of ${targets.length}, --limit)` : "") +
      (skippedLive ? `, ${skippedLive} skipped as in flight` : "") +
      `, concurrency ${concurrency}.`,
  );
  for (const t of selected) console.log(`  ${t.entryNumber}  ${t.reason}  ${t.orgId}`);

  if (!run) {
    console.log("\nDRY RUN — pass --run to analyze.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required: the stub analyst never persists.");
  }
  // Abandoned rows (a dead Vercel drain) otherwise pin the entry page's
  // "running" state forever, even after a fresh run succeeds.
  if (staleRunning.size > 0) {
    const { failed } = await failAbandonedRuns(db, { olderThanMs: STALE_RUNNING_MS });
    console.log(`Marked ${failed} abandoned running row(s) as failed.`);
  }
  if (selected.length === 0) return;

  const started = Date.now();
  const results: { entryNumber: string; status: string; findings: number; ms: number; error: string | null }[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const t = selected[next++];
      if (!t) return;
      const t0 = Date.now();
      try {
        const outcome = await runEntryAnalysis(db, t.orgId, t.id, "manual");
        const ms = Date.now() - t0;
        results.push({ entryNumber: t.entryNumber, status: outcome.status, findings: outcome.findingsCount, ms, error: outcome.error });
        console.log(
          `[${results.length}/${selected.length}] ${t.entryNumber}  ${outcome.status}  ` +
            `${outcome.findingsCount} finding(s)  ${fmtMs(ms)}` +
            (outcome.error ? `  error: ${outcome.error}` : ""),
        );
      } catch (err) {
        const ms = Date.now() - t0;
        const message = err instanceof Error ? err.message : String(err);
        results.push({ entryNumber: t.entryNumber, status: "threw", findings: 0, ms, error: message });
        console.log(`[${results.length}/${selected.length}] ${t.entryNumber}  THREW  ${fmtMs(ms)}  ${message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const ok = results.filter((r) => r.status === "succeeded");
  const bad = results.filter((r) => r.status !== "succeeded");
  console.log(
    `\nDone in ${fmtMs(Date.now() - started)}: ${ok.length} succeeded, ${bad.length} failed, ` +
      `${ok.reduce((n, r) => n + r.findings, 0)} findings persisted.`,
  );
  for (const r of bad) console.log(`  FAILED ${r.entryNumber}: ${r.error}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
