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

import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  like,
  lt,
  sql,
} from "drizzle-orm";

import * as schema from "../db/schema";
import { isUnscoped, lineMatchesScope } from "../audit/suppression";
import { loadReferenceDataForOrg, type DbClient } from "../duty/reference";
import type { SuppressionSpec } from "../org-rules";
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
  const analyst = requireAnalyst(opts.analyst);

  const pending = await db.query.analysisRuns.findFirst({
    where: and(
      eq(schema.analysisRuns.entryId, entryId),
      eq(schema.analysisRuns.status, "pending"),
    ),
    columns: { id: true },
  });
  // A manual run always runs: if the sweep claimed the pending row between
  // our read and our claim, this run simply gets its own row.
  let runId = pending ? await claimPendingRun(db, pending.id, analyst) : null;
  if (!runId) {
    const [inserted] = await db
      .insert(schema.analysisRuns)
      .values({
        orgId,
        entryId,
        status: "running",
        trigger,
        analyst: "claude",
        model: modelOf(analyst),
        startedAt: new Date(),
      })
      .returning({ id: schema.analysisRuns.id });
    runId = inserted.id;
  }

  return executeRun(db, orgId, entryId, runId, analyst);
}

/** An injected analyst (tests, scripts) is trusted; the env-selected one
 *  must be the real model — the stub's output never persists. */
function requireAnalyst(injected?: EntryAnalyst): EntryAnalyst {
  if (!injected && !process.env.ANTHROPIC_API_KEY) {
    throw new AnalysisNotConfiguredError(
      "AI analysis needs ANTHROPIC_API_KEY. The stub analyst never persists findings.",
    );
  }
  return injected ?? getEntryAnalyst();
}

function modelOf(analyst: EntryAnalyst): string | null {
  return "model" in analyst && typeof analyst.model === "string"
    ? analyst.model
    : null;
}

/** Guarded claim of one pending row: status flips to running only if it is
 *  still pending, so two drains racing for the same row (overlapping sweep
 *  invocations, a manual run beside the sweep) resolve to exactly one
 *  runner. Returns the run id on success, null if someone else won. */
async function claimPendingRun(
  db: DbClient,
  runId: string,
  analyst: EntryAnalyst,
): Promise<string | null> {
  const [claimed] = await db
    .update(schema.analysisRuns)
    .set({
      status: "running",
      analyst: "claude",
      model: modelOf(analyst),
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.analysisRuns.id, runId),
        eq(schema.analysisRuns.status, "pending"),
      ),
    )
    .returning({ id: schema.analysisRuns.id });
  return claimed?.id ?? null;
}

/** Investigate against a claimed (running) row and persist the outcome. */
async function executeRun(
  db: DbClient,
  orgId: string,
  entryId: string,
  runId: string,
  analyst: EntryAnalyst,
): Promise<RunAnalysisOutcome> {
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
 * inside the tariff-apply transaction. Entries never analyzed are left to
 * the sweep's backfill leg (they get a first run regardless), so an apply
 * only ever pays for the re-runs it actually invalidates. Returns the
 * number queued.
 */
export async function queueReanalysesAllOrgs(db: DbClient): Promise<number> {
  const analyzed = await db
    .selectDistinct({
      entryId: schema.analysisRuns.entryId,
      orgId: schema.analysisRuns.orgId,
    })
    .from(schema.analysisRuns)
    .where(eq(schema.analysisRuns.status, "succeeded"));
  return queueAnalysesForEntries(db, analyzed, "tariff_apply");
}

/**
 * Scoped variant: enqueue re-analysis only for the entries a tariff change
 * actually touches (still filtered to entries the analyst has cleanly
 * analyzed — the sweep's backfill covers the rest). The apply routes
 * compute the touched set from the changed codes and pass it here inside
 * the apply transaction.
 */
export async function queueReanalysesForEntries(
  db: DbClient,
  entryIds: string[],
): Promise<number> {
  const ids = [...new Set(entryIds)];
  const analyzed: { entryId: string; orgId: string }[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    analyzed.push(
      ...(await db
        .selectDistinct({
          entryId: schema.analysisRuns.entryId,
          orgId: schema.analysisRuns.orgId,
        })
        .from(schema.analysisRuns)
        .where(
          and(
            eq(schema.analysisRuns.status, "succeeded"),
            inArray(schema.analysisRuns.entryId, batch),
          ),
        )),
    );
  }
  return queueAnalysesForEntries(db, analyzed, "tariff_apply");
}

/**
 * Org-rule sibling of the tariff-apply queues: an org rule changed, so the
 * analyst's standing instructions moved and its prior judgments on this
 * org's entries need re-deriving — a clean re-run withdraws findings the
 * rule now covers (they clear via the finding_key reconcile) and can
 * surface new ones the rule demands. Still filtered to entries the analyst
 * has cleanly analyzed: never-analyzed entries get their first run from
 * the sweep's backfill leg, under the rules as they stand then.
 *
 * `scopes` bounds the blast radius (each re-run is a real model
 * investigation): one element per rule state the change touched — the
 * before spec and/or the after spec on an edit, one spec on create/delete.
 * A guidance rule (null) or an unscoped spec has no structured scope, so
 * the whole analyzed set queues; a scoped spec queues only entries with a
 * line matching its axes, via the auditor's own lineMatchesScope so the
 * two layers can never disagree. alertTypes are deliberately ignored here:
 * they name audit alert types, and the analyst re-judges the entry
 * holistically anyway.
 */
export async function queueReanalysesForOrgRule(
  db: DbClient,
  orgId: string,
  scopes: (SuppressionSpec | null)[],
): Promise<number> {
  if (scopes.length === 0) return 0;

  const analyzed = await db
    .selectDistinct({
      entryId: schema.analysisRuns.entryId,
      orgId: schema.analysisRuns.orgId,
    })
    .from(schema.analysisRuns)
    .where(
      and(
        eq(schema.analysisRuns.orgId, orgId),
        eq(schema.analysisRuns.status, "succeeded"),
      ),
    );
  if (analyzed.length === 0) return 0;

  const specs = scopes.filter((s): s is SuppressionSpec => s !== null);
  const everything =
    specs.length < scopes.length || specs.some(isUnscoped);

  let targets = analyzed;
  if (!everything) {
    const matched = new Set<string>();
    const ids = analyzed.map((a) => a.entryId);
    for (let i = 0; i < ids.length; i += 500) {
      const lines = await db.query.entryLineItems.findMany({
        where: and(
          eq(schema.entryLineItems.orgId, orgId),
          inArray(schema.entryLineItems.entryId, ids.slice(i, i + 500)),
        ),
        columns: {
          entryId: true,
          supplierName: true,
          countryOfOrigin: true,
          htsCodeDigits: true,
        },
      });
      for (const line of lines) {
        if (specs.some((spec) => lineMatchesScope(line, spec))) {
          matched.add(line.entryId);
        }
      }
    }
    targets = analyzed.filter((a) => matched.has(a.entryId));
  }
  return queueAnalysesForEntries(db, targets, "org_rule");
}

/**
 * Enqueue an analysis for each entry. An entry already pending keeps its
 * one row (the partial unique index guarantees it even across racing
 * writers — the loser's insert is a no-op) but gets touched, so the sweep's
 * settle window restarts: a packet's 7501 and CI both land before the
 * analyst starts. Chunked — the set can span the whole book. Returns the
 * number of NEW pending rows.
 */
export async function queueAnalysesForEntries(
  db: DbClient,
  targets: { entryId: string; orgId: string }[],
  trigger: schema.AnalysisRunTriggerValue,
): Promise<number> {
  const seen = new Set<string>();
  const unique: { entryId: string; orgId: string }[] = [];
  for (const t of targets) {
    if (seen.has(t.entryId)) continue;
    seen.add(t.entryId);
    unique.push(t);
  }
  if (unique.length === 0) return 0;

  let queued = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const touched = await db
      .update(schema.analysisRuns)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(schema.analysisRuns.status, "pending"),
          inArray(
            schema.analysisRuns.entryId,
            batch.map((t) => t.entryId),
          ),
        ),
      )
      .returning({ entryId: schema.analysisRuns.entryId });
    const alreadyPending = new Set(touched.map((r) => r.entryId));
    const toInsert = batch.filter((t) => !alreadyPending.has(t.entryId));
    if (toInsert.length === 0) continue;
    const inserted = await db
      .insert(schema.analysisRuns)
      .values(
        toInsert.map((t) => ({
          orgId: t.orgId,
          entryId: t.entryId,
          status: "pending" as const,
          trigger,
        })),
      )
      .onConflictDoNothing({
        target: schema.analysisRuns.entryId,
        where: sql`status = 'pending'`,
      })
      .returning({ id: schema.analysisRuns.id });
    queued += inserted.length;
  }
  return queued;
}

/**
 * Seed a first analysis for every entry (all orgs) with no run row at all
 * and a processed 7501 on file — the sweep's backfill leg, which is what
 * makes analysis automatic for entries that arrived outside the processing
 * hook (rows from before the hook existed). The 7501 gate is the principle
 * behind the hook too: the customs summary is the primary document, and an
 * entry without one (a seed row, a stub) has nothing for the analyst to
 * judge. Entries whose only runs failed are NOT re-seeded: a refusal or
 * deadline would otherwise retry every pass at real cost; they re-queue on
 * their next primary-document change or a manual run.
 */
export async function queueAnalysesForUnanalyzedEntries(
  db: DbClient,
): Promise<number> {
  const rows = await db
    .select({ entryId: schema.entries.id, orgId: schema.entries.orgId })
    .from(schema.entries)
    .leftJoin(
      schema.analysisRuns,
      eq(schema.analysisRuns.entryId, schema.entries.id),
    )
    .where(
      and(
        isNull(schema.analysisRuns.id),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.documentLinks)
            .innerJoin(
              schema.documents,
              eq(schema.documents.id, schema.documentLinks.documentId),
            )
            .where(
              and(
                eq(schema.documentLinks.entityType, "entry"),
                eq(schema.documentLinks.entityId, schema.entries.id),
                eq(schema.documents.docType, "port_entry"),
                eq(schema.documents.status, "processed"),
              ),
            ),
        ),
      ),
    );
  return queueAnalysesForEntries(db, rows, "backfill");
}

/**
 * Every entry whose analysis bundle includes this document: linked to the
 * entry itself, or to a shipment / PO / invoice on the entry — the inverse
 * of loadEntryBundle's document fan-out, so a document landing anywhere in
 * an entry's orbit re-queues that entry.
 */
export async function findEntriesForDocument(
  db: DbClient,
  orgId: string,
  documentId: string,
): Promise<{ entryId: string; orgId: string }[]> {
  const links = await db
    .select({
      entityType: schema.documentLinks.entityType,
      entityId: schema.documentLinks.entityId,
    })
    .from(schema.documentLinks)
    .where(
      and(
        eq(schema.documentLinks.orgId, orgId),
        eq(schema.documentLinks.documentId, documentId),
      ),
    );
  const idsOf = (type: (typeof links)[number]["entityType"]) =>
    links.filter((l) => l.entityType === type).map((l) => l.entityId);

  const entryIds = new Set(idsOf("entry"));
  const shipmentIds = idsOf("shipment");
  const poIds = idsOf("purchase_order");
  const invoiceIds = idsOf("invoice");
  if (shipmentIds.length > 0) {
    const rows = await db.query.entryShipments.findMany({
      where: inArray(schema.entryShipments.shipmentId, shipmentIds),
      columns: { entryId: true },
    });
    for (const r of rows) entryIds.add(r.entryId);
  }
  if (poIds.length > 0) {
    const rows = await db.query.entryPurchaseOrders.findMany({
      where: inArray(schema.entryPurchaseOrders.purchaseOrderId, poIds),
      columns: { entryId: true },
    });
    for (const r of rows) entryIds.add(r.entryId);
  }
  if (invoiceIds.length > 0) {
    const rows = await db.query.entryInvoices.findMany({
      where: inArray(schema.entryInvoices.invoiceId, invoiceIds),
      columns: { entryId: true },
    });
    for (const r of rows) entryIds.add(r.entryId);
  }
  return [...entryIds].map((entryId) => ({ entryId, orgId }));
}

export type ProcessQueueSummary = {
  processed: number;
  succeeded: number;
  failed: number;
  /** Rows another runner claimed first (overlapping drains). */
  skipped: number;
  /** Pending rows left after this pass (cap or budget hit, settle window,
   *  or analyst unconfigured). */
  remaining: number;
};

export type DrainOptions = {
  /** Pending rows considered this pass, oldest first. */
  limit?: number;
  /** Parallel investigations. */
  concurrency?: number;
  /** Claim new rows only while this much wall time has elapsed — sized so
   *  an investigation claimed at the budget's edge (analyst deadline 600s)
   *  still finishes inside the caller's function lifetime. */
  budgetMs?: number;
  /** Skip pending rows touched more recently than this — the settle window
   *  that lets a packet's parts all land before the analyst starts. */
  settleMs?: number;
};

/** What an after()-response drain may spend: a few investigations claimed
 *  up front, none later — inside a maxDuration=800 route that leaves the
 *  analyst's 600s deadline plus margin. The sweep cron takes the rest. */
export const AFTER_RESPONSE_DRAIN: DrainOptions = {
  limit: 3,
  concurrency: 3,
  budgetMs: 60_000,
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
  opts: DrainOptions = {},
): Promise<ProcessQueueSummary> {
  const limit = opts.limit ?? 10;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const budgetMs = opts.budgetMs ?? Number.POSITIVE_INFINITY;
  const settleMs = opts.settleMs ?? 0;
  const pending = await db.query.analysisRuns.findMany({
    where: and(
      eq(schema.analysisRuns.status, "pending"),
      settleMs > 0
        ? lt(schema.analysisRuns.updatedAt, new Date(Date.now() - settleMs))
        : undefined,
    ),
    orderBy: [asc(schema.analysisRuns.createdAt)],
    limit,
    columns: { id: true, orgId: true, entryId: true },
  });
  const summary: ProcessQueueSummary = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
  };
  if (pending.length === 0) return summary;

  if (!process.env.ANTHROPIC_API_KEY) {
    summary.remaining = pending.length;
    return summary;
  }
  const analyst = getEntryAnalyst();
  const started = Date.now();
  const queue = [...pending];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (Date.now() - started < budgetMs) {
        const run = queue.shift();
        if (!run) return;
        const runId = await claimPendingRun(db, run.id, analyst);
        if (!runId) {
          summary.skipped += 1;
          continue;
        }
        const outcome = await executeRun(
          db,
          run.orgId,
          run.entryId,
          runId,
          analyst,
        );
        summary.processed += 1;
        if (outcome.status === "succeeded") summary.succeeded += 1;
        else summary.failed += 1;
      }
    }),
  );
  const left = await db.query.analysisRuns.findMany({
    where: eq(schema.analysisRuns.status, "pending"),
    columns: { id: true },
  });
  summary.remaining = left.length;
  return summary;
}

const ABANDONED_ERROR = "abandoned: the runner exited before the analyst finished";
/** A run that dies this many times stops retrying — a crashloop, not a
 *  killed function. It re-queues on the entry's next change or a manual run. */
const MAX_ABANDONED_RETRIES = 2;

/**
 * Mark "running" rows older than `olderThanMs` as failed. A row only ever
 * leaves "running" through recordAnalysisResult, so one that has outlived
 * the analyst's deadline by a wide margin belongs to a runner that died
 * mid-flight (a function cut off at its timeout, a deploy). Left alone it
 * pins the entry page's "running" state forever. With `requeue`, each
 * reclaimed entry gets a fresh pending row under its original trigger,
 * bounded by MAX_ABANDONED_RETRIES.
 */
export async function failAbandonedRuns(
  db: DbClient,
  opts: { olderThanMs?: number; entryId?: string; requeue?: boolean } = {},
): Promise<{ failed: number; requeued: number }> {
  const olderThanMs = opts.olderThanMs ?? 20 * 60 * 1000;
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .update(schema.analysisRuns)
    .set({
      status: "failed",
      error: ABANDONED_ERROR,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.analysisRuns.status, "running"),
        lt(schema.analysisRuns.startedAt, cutoff),
        opts.entryId ? eq(schema.analysisRuns.entryId, opts.entryId) : undefined,
      ),
    )
    .returning({
      entryId: schema.analysisRuns.entryId,
      orgId: schema.analysisRuns.orgId,
      trigger: schema.analysisRuns.trigger,
    });
  if (!opts.requeue || rows.length === 0) {
    return { failed: rows.length, requeued: 0 };
  }

  const deaths = await db
    .select({
      entryId: schema.analysisRuns.entryId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.analysisRuns)
    .where(
      and(
        eq(schema.analysisRuns.status, "failed"),
        like(schema.analysisRuns.error, "abandoned:%"),
        inArray(
          schema.analysisRuns.entryId,
          rows.map((r) => r.entryId),
        ),
      ),
    )
    .groupBy(schema.analysisRuns.entryId);
  const deathsByEntry = new Map(deaths.map((d) => [d.entryId, d.count]));

  let requeued = 0;
  const byTrigger = new Map<
    schema.AnalysisRunTriggerValue,
    { entryId: string; orgId: string }[]
  >();
  for (const r of rows) {
    if ((deathsByEntry.get(r.entryId) ?? 0) > MAX_ABANDONED_RETRIES) continue;
    const list = byTrigger.get(r.trigger) ?? [];
    list.push({ entryId: r.entryId, orgId: r.orgId });
    byTrigger.set(r.trigger, list);
  }
  for (const [trigger, targets] of byTrigger) {
    requeued += await queueAnalysesForEntries(db, targets, trigger);
  }
  return { failed: rows.length, requeued };
}

// Compile-time + test-time guard that the column enum and the analyst's
// output enum stay value-identical (see analysis_finding_category comment).
export const FINDING_CATEGORY_VALUES = findingCategorySchema.options;
