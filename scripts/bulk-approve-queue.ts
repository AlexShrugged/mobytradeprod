// Bulk-approve the staged tariff queue per a plan file: fold reviewer-
// confirmed dates/programs/scopes into each member's proposal, approve the
// group item, and apply — replicating PATCH /api/tariff-sync/groups/[id]
// (same transaction shape, same single-writer functions), then re-audit.
//
//   DATABASE_URL=postgres://... npx tsx scripts/bulk-approve-queue.ts <plan.json> [--apply]
//
// Default is DRY RUN: every group runs inside one transaction that is
// rolled back at the end, so validation (dates, worldwide gate, program
// conflicts incl. cross-group supersedes) executes against real data with
// zero writes. --apply commits, one transaction per group, in plan order.
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";

import {
  queueReanalysesAllOrgs,
  queueReanalysesForEntries,
} from "../src/lib/analysis/service";
import {
  findEntriesForMeasures,
  sweepAuditsAllOrgs,
} from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import type { DbClient } from "../src/lib/duty/reference";
import {
  applyRevisionGroup,
  ApplyValidationError,
} from "../src/lib/tariff-sync/apply";
import type { ProposedMeasureChange } from "../src/lib/tariff-sync/types";

const DECIDED_BY = "alex@countless.ai — scripted bulk approval 2026-08-17";

type PlanGroup = {
  order: number;
  groupId: string;
  prefix: string;
  authority: string;
  title: string;
  note: string;
  defaultEffectiveDate: string | null;
  confirmWorldwide: boolean;
  skipRevisionIds: string[];
  skipCodes: string[];
  edits: Record<string, Partial<ProposedMeasureChange>>;
};

class Rollback extends Error {}

async function approveGroup(tx: DbClient, g: PlanGroup) {
  const item = await tx.query.reviewItems.findFirst({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_group"),
      eq(schema.reviewItems.subjectId, g.groupId),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  if (!item) throw new ApplyValidationError(`no pending item for group ${g.prefix}/${g.authority}`);

  // Fold the plan's per-member confirmations into the proposals first —
  // apply writes exactly what the reviewer confirmed (route parity; the
  // route folds dates the same way before applyRevision).
  for (const [revisionId, edit] of Object.entries(g.edits)) {
    const rev = await tx.query.measureRevisions.findFirst({
      where: eq(schema.measureRevisions.id, revisionId),
    });
    if (!rev) throw new ApplyValidationError(`revision ${revisionId} missing`);
    if (rev.appliedAt) throw new ApplyValidationError(`revision ${revisionId} already applied`);
    const proposed = { ...(rev.proposed as ProposedMeasureChange), ...edit };
    await tx
      .update(schema.measureRevisions)
      .set({ proposed, updatedAt: new Date() })
      .where(eq(schema.measureRevisions.id, revisionId));
  }

  await tx
    .update(schema.reviewItems)
    .set({
      status: "approved",
      resolutionAction: "accept",
      decidedBy: DECIDED_BY,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.reviewItems.id, item.id));

  const applied = await applyRevisionGroup(tx, g.groupId, {
    defaultEffectiveDate: g.defaultEffectiveDate ?? undefined,
    confirmWorldwide: g.confirmWorldwide,
    skipRevisionIds: g.skipRevisionIds,
    decidedBy: DECIDED_BY,
  });
  if (!applied) throw new ApplyValidationError(`group ${g.groupId} not found`);

  const members = await tx.query.measureRevisions.findMany({
    where: eq(schema.measureRevisions.groupId, g.groupId),
    columns: { targetMeasureId: true },
  });
  const targets =
    applied.changedMeasureIds.length === 0
      ? []
      : await findEntriesForMeasures(tx, [
          ...applied.changedMeasureIds,
          ...members
            .map((m) => m.targetMeasureId)
            .filter((id): id is string => id !== null),
        ]);
  const analysesQueued =
    targets === null
      ? await queueReanalysesAllOrgs(tx)
      : await queueReanalysesForEntries(
          tx,
          targets.map((t) => t.entryId),
        );

  return { applied, targets, analysesQueued };
}

async function main() {
  const [planPath, applyFlag] = process.argv.slice(2);
  if (!planPath) {
    console.error("Usage: npx tsx scripts/bulk-approve-queue.ts <plan.json> [--apply]");
    process.exit(1);
  }
  const live = applyFlag === "--apply";
  const plan = (JSON.parse(readFileSync(planPath, "utf8")) as PlanGroup[]).sort(
    (a, b) => a.order - b.order,
  );

  const summary: unknown[] = [];

  if (!live) {
    // Dry run: all groups, one rolled-back transaction — cross-group
    // program interactions (e.g. ieepa-reciprocal spanning 990301+990302)
    // validate against the mid-flight state exactly as the real run will.
    try {
      await db.transaction(async (tx) => {
        for (const g of plan) {
          const r = await approveGroup(tx, g);
          summary.push({
            group: `${g.prefix}/${g.authority}`,
            applied: r.applied.applied,
            rejected: r.applied.rejected,
            superseded: r.applied.superseded,
            entryTargets: r.targets === null ? "ALL" : r.targets.length,
            analysesQueued: r.analysesQueued,
          });
        }
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    console.log(JSON.stringify({ mode: "dry-run", groups: summary }, null, 1));
    return;
  }

  for (const g of plan) {
    const r = await db.transaction((tx) => approveGroup(tx, g));
    const row = {
      group: `${g.prefix}/${g.authority}`,
      applied: r.applied.applied,
      rejected: r.applied.rejected,
      superseded: r.applied.superseded,
      entryTargets: r.targets === null ? "ALL" : r.targets.length,
      analysesQueued: r.analysesQueued,
    };
    summary.push(row);
    console.log(JSON.stringify(row));
  }
  // One full sweep after the batch: the auditor derives from final
  // reference state and reconciles idempotently by alert_key, so a single
  // post-batch sweep equals the route's per-approval sweeps.
  let audit: unknown = null;
  let auditError: string | null = null;
  try {
    audit = await sweepAuditsAllOrgs(db);
  } catch (err) {
    auditError = err instanceof Error ? err.message : String(err);
  }
  console.log(
    JSON.stringify({ mode: "applied", groups: summary.length, audit, auditError }, null, 0),
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
