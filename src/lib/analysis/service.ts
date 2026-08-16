// The sole writer to analysis_runs and analysis_findings. Mirrors the
// auditor's reconcile contract for audit_alerts: findings reconcile by a
// stable finding_key, new keys insert open, open rows refresh or delete as
// the analyst's opinion changes, and resolved/dismissed rows are never
// touched — a human's judgment outlives re-analysis. Two guards the auditor
// does not need:
//   - only a CLEAN claude run reconciles findings. A failed/degraded run
//     (deadline, refusal, stub fallback) records as a failed run and leaves
//     prior findings alone — a partial report must not delete good ones.
//   - the stub analyst never persists: its findings merely echo the
//     deterministic alerts, which audit_alerts already carries.
//
// Relative imports + DbClient parameter on purpose — this module must stay
// reachable from tsx scripts.

import { and, asc, eq, inArray } from "drizzle-orm";

import * as schema from "../db/schema";
import { loadReferenceDataForOrg, type DbClient } from "../duty/reference";
import { getEntryAnalyst } from "./index";
import { loadEntryBundle } from "./bundle";
import { findingCategorySchema, type Finding } from "./findings";
import type { AnalystResult, EntryAnalyst } from "./types";

export class AnalysisNotConfiguredError extends Error {}

/** Stable reconcile key: category + line scope, with a report-order ordinal
 *  when one run flags the same (category, line) more than once. Titles are
 *  model-phrased and drift between runs; category+line is what stays put. */
export function assignFindingKeys(
  findings: Finding[],
): { key: string; finding: Finding }[] {
  const counts = new Map<string, number>();
  return findings.map((finding) => {
    const base = `ai:${finding.category}:${finding.lineNumber ?? "entry"}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return { key: n === 1 ? base : `${base}#${n}`, finding };
  });
}

/** Key-order-insensitive deep equality (jsonb round-trips reorder keys) —
 *  same contract as the auditor's private stableStringify. */
function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const record = v as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",");
  return `{${body}}`;
}

export type ExistingFindingRow = {
  id: string;
  findingKey: string;
  status: "open" | "resolved" | "dismissed";
  severity: "error" | "warning" | "info";
  title: string;
  explanation: string;
  suggestedAction: string;
  confidence: string;
  lineItemId: string | null;
  fields: unknown;
  evidence: unknown;
  relatedAlertKeys: unknown;
};

export type DesiredFinding = {
  key: string;
  finding: Finding;
  lineItemId: string | null;
};

export type FindingReconcilePlan = {
  toInsert: DesiredFinding[];
  toUpdate: { id: string; desired: DesiredFinding }[];
  toDeleteIds: string[];
};

const confidenceString = (c: number): string =>
  Math.min(1, Math.max(0, c)).toFixed(3);

/** Pure reconcile decision, test-pinned. Insert keys nobody holds (any
 *  status — a resolved key blocks re-insert, the judgment stands), refresh
 *  open rows whose content drifted, delete open rows the analyst no longer
 *  reports. */
export function planFindingReconcile(
  existing: ExistingFindingRow[],
  desired: DesiredFinding[],
): FindingReconcilePlan {
  const byKey = new Map(existing.map((e) => [e.findingKey, e]));
  const desiredKeys = new Set(desired.map((d) => d.key));

  const toInsert = desired.filter((d) => !byKey.has(d.key));
  const toUpdate: { id: string; desired: DesiredFinding }[] = [];
  for (const d of desired) {
    const ex = byKey.get(d.key);
    if (!ex || ex.status !== "open") continue;
    const unchanged =
      ex.severity === d.finding.severity &&
      ex.title === d.finding.title &&
      ex.explanation === d.finding.explanation &&
      ex.suggestedAction === d.finding.suggestedAction &&
      ex.confidence === confidenceString(d.finding.confidence) &&
      ex.lineItemId === d.lineItemId &&
      stableStringify(ex.fields) === stableStringify(d.finding.fields) &&
      stableStringify(ex.evidence) === stableStringify(d.finding.evidence) &&
      stableStringify(ex.relatedAlertKeys) ===
        stableStringify(d.finding.relatedAlertKeys);
    if (!unchanged) toUpdate.push({ id: ex.id, desired: d });
  }
  const toDeleteIds = existing
    .filter((e) => e.status === "open" && !desiredKeys.has(e.findingKey))
    .map((e) => e.id);
  return { toInsert, toUpdate, toDeleteIds };
}

async function reconcileFindings(
  db: DbClient,
  orgId: string,
  entryId: string,
  runId: string,
  findings: Finding[],
): Promise<void> {
  const lines = await db.query.entryLineItems.findMany({
    where: eq(schema.entryLineItems.entryId, entryId),
    columns: { id: true, lineNumber: true },
  });
  const lineIdByNumber = new Map(lines.map((l) => [l.lineNumber, l.id]));

  const desired: DesiredFinding[] = assignFindingKeys(findings).map(
    ({ key, finding }) => ({
      key,
      finding,
      lineItemId:
        finding.lineNumber === null
          ? null
          : (lineIdByNumber.get(finding.lineNumber) ?? null),
    }),
  );

  const existing = await db.query.analysisFindings.findMany({
    where: eq(schema.analysisFindings.entryId, entryId),
  });
  const plan = planFindingReconcile(existing, desired);

  if (plan.toInsert.length > 0) {
    await db.insert(schema.analysisFindings).values(
      plan.toInsert.map(({ key, finding, lineItemId }) => ({
        orgId,
        entryId,
        lineItemId,
        findingKey: key,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        explanation: finding.explanation,
        suggestedAction: finding.suggestedAction,
        confidence: confidenceString(finding.confidence),
        lineNumber: finding.lineNumber,
        fields: finding.fields,
        evidence: finding.evidence,
        relatedAlertKeys: finding.relatedAlertKeys,
        runId,
      })),
    );
  }
  for (const { id, desired: d } of plan.toUpdate) {
    await db
      .update(schema.analysisFindings)
      .set({
        severity: d.finding.severity,
        title: d.finding.title,
        explanation: d.finding.explanation,
        suggestedAction: d.finding.suggestedAction,
        confidence: confidenceString(d.finding.confidence),
        lineItemId: d.lineItemId,
        fields: d.finding.fields,
        evidence: d.finding.evidence,
        relatedAlertKeys: d.finding.relatedAlertKeys,
        runId,
        updatedAt: new Date(),
      })
      .where(eq(schema.analysisFindings.id, id));
  }
  if (plan.toDeleteIds.length > 0) {
    await db
      .delete(schema.analysisFindings)
      .where(inArray(schema.analysisFindings.id, plan.toDeleteIds));
  }
}

export type RunAnalysisOutcome = {
  runId: string;
  status: "succeeded" | "failed";
  summary: string | null;
  error: string | null;
  findingsCount: number;
};

/**
 * Run the analyst over one entry and persist the outcome. Claims the
 * entry's pending queue row if one exists (so a manual run also drains the
 * tariff-apply queue), otherwise inserts a fresh run. The analyst call runs
 * OUTSIDE any transaction — it takes minutes — and only the final findings
 * reconcile is transactional.
 *
 * Refuses the stub analyst: persisted "analysis" that merely echoes the
 * deterministic alerts is worse than an explicit configuration failure.
 */
export async function runEntryAnalysis(
  db: DbClient,
  orgId: string,
  entryId: string,
  trigger: schema.AnalysisRunTriggerValue,
  opts: { analyst?: EntryAnalyst } = {},
): Promise<RunAnalysisOutcome> {
  // An injected analyst (tests, scripts) is trusted; the env-selected one
  // must be the real model — the stub's output never persists.
  if (!opts.analyst && !process.env.ANTHROPIC_API_KEY) {
    throw new AnalysisNotConfiguredError(
      "AI analysis needs ANTHROPIC_API_KEY. The stub analyst never persists findings.",
    );
  }
  const analyst = opts.analyst ?? getEntryAnalyst();
  const model =
    "model" in analyst && typeof analyst.model === "string"
      ? analyst.model
      : null;

  const pending = await db.query.analysisRuns.findFirst({
    where: and(
      eq(schema.analysisRuns.entryId, entryId),
      eq(schema.analysisRuns.status, "pending"),
    ),
  });
  let runId: string;
  if (pending) {
    runId = pending.id;
    await db
      .update(schema.analysisRuns)
      .set({
        status: "running",
        analyst: "claude",
        model,
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.analysisRuns.id, pending.id));
  } else {
    const [inserted] = await db
      .insert(schema.analysisRuns)
      .values({
        orgId,
        entryId,
        status: "running",
        trigger,
        analyst: "claude",
        model,
        startedAt: new Date(),
      })
      .returning({ id: schema.analysisRuns.id });
    runId = inserted.id;
  }

  let result: AnalystResult;
  try {
    const bundle = await loadEntryBundle(db, orgId, entryId);
    if (!bundle) throw new Error("entry bundle failed to load");
    const ref = await loadReferenceDataForOrg(db, orgId);
    result = await analyst.analyze(bundle, ref);
  } catch (err) {
    // analyze() never throws by contract; this catches bundle/reference IO.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.analysisRuns)
      .set({ status: "failed", error: message, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.analysisRuns.id, runId));
    return { runId, status: "failed", summary: null, error: message, findingsCount: 0 };
  }

  return recordAnalysisResult(db, orgId, entryId, runId, result);
}

/** Persist one analyst result against its claimed run row. Exposed for the
 *  eval harness's opt-in persistence; production paths arrive here via
 *  runEntryAnalysis. */
export async function recordAnalysisResult(
  db: DbClient,
  orgId: string,
  entryId: string,
  runId: string,
  result: AnalystResult,
): Promise<RunAnalysisOutcome> {
  const clean = result.error === null && result.analyst === "claude";
  if (clean) {
    await reconcileFindings(db, orgId, entryId, runId, result.report.findings);
  }
  await db
    .update(schema.analysisRuns)
    .set({
      status: clean ? "succeeded" : "failed",
      analyst: result.analyst,
      summary: clean ? result.report.summary : null,
      error: result.error,
      usage: result.usage,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.analysisRuns.id, runId));
  return {
    runId,
    status: clean ? "succeeded" : "failed",
    summary: clean ? result.report.summary : null,
    error: result.error,
    findingsCount: clean ? result.report.findings.length : 0,
  };
}

/**
 * Enqueue a re-analysis for every entry (all orgs) the analyst has ever
 * cleanly analyzed — the analysis sibling of sweepAuditsAllOrgs, called
 * inside the tariff-apply transaction. Entries never analyzed are not
 * enqueued: analysis is opt-in per entry, and a global apply must not mint
 * a bill for the whole book. Returns the number queued.
 */
export async function queueReanalysesAllOrgs(db: DbClient): Promise<number> {
  const analyzed = await db
    .selectDistinct({
      entryId: schema.analysisRuns.entryId,
      orgId: schema.analysisRuns.orgId,
    })
    .from(schema.analysisRuns)
    .where(eq(schema.analysisRuns.status, "succeeded"));
  if (analyzed.length === 0) return 0;

  const alreadyQueued = await db.query.analysisRuns.findMany({
    where: and(
      eq(schema.analysisRuns.status, "pending"),
      inArray(
        schema.analysisRuns.entryId,
        analyzed.map((a) => a.entryId),
      ),
    ),
    columns: { entryId: true },
  });
  const queuedIds = new Set(alreadyQueued.map((r) => r.entryId));
  const toQueue = analyzed.filter((a) => !queuedIds.has(a.entryId));
  if (toQueue.length === 0) return 0;

  await db.insert(schema.analysisRuns).values(
    toQueue.map((a) => ({
      orgId: a.orgId,
      entryId: a.entryId,
      status: "pending" as const,
      trigger: "tariff_apply" as const,
    })),
  );
  return toQueue.length;
}

export type ProcessQueueSummary = {
  processed: number;
  succeeded: number;
  failed: number;
  /** Pending rows left after this pass (cap hit, or analyst unconfigured). */
  remaining: number;
};

/**
 * Drain pending analysis runs, oldest first, serially — each is a real
 * model investigation (minutes, dollars). `limit` caps one pass; leftovers
 * stay pending and are picked up by the next pass or a manual run. With no
 * ANTHROPIC_API_KEY the queue is left untouched (visible as "queued" in the
 * UI) rather than drained by the stub.
 */
export async function processPendingAnalyses(
  db: DbClient,
  opts: { limit?: number } = {},
): Promise<ProcessQueueSummary> {
  const limit = opts.limit ?? 10;
  const pending = await db.query.analysisRuns.findMany({
    where: eq(schema.analysisRuns.status, "pending"),
    orderBy: [asc(schema.analysisRuns.createdAt)],
    limit,
  });
  const summary: ProcessQueueSummary = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    remaining: 0,
  };
  if (pending.length === 0) return summary;

  if (!process.env.ANTHROPIC_API_KEY) {
    summary.remaining = pending.length;
    return summary;
  }
  for (const run of pending) {
    const outcome = await runEntryAnalysis(
      db,
      run.orgId,
      run.entryId,
      run.trigger,
    );
    summary.processed += 1;
    if (outcome.status === "succeeded") summary.succeeded += 1;
    else summary.failed += 1;
  }
  const left = await db.query.analysisRuns.findMany({
    where: eq(schema.analysisRuns.status, "pending"),
    columns: { id: true },
  });
  summary.remaining = left.length;
  return summary;
}

// Compile-time + test-time guard that the column enum and the analyst's
// output enum stay value-identical (see analysis_finding_category comment).
export const FINDING_CATEGORY_VALUES = findingCategorySchema.options;
