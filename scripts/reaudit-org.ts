// Re-run the deterministic audit over every entry of one org, in place —
// the follow-up to an audit-rule change that no document or tariff event
// re-triggers on its own (the auditor only re-audits an entry when its
// bundle or the reference data it touches moves). The sweep reconciles by
// alert_key: stale open alerts close, new findings open, resolved and
// dismissed rows are never touched.
//
//   npx tsx scripts/reaudit-org.ts <org name or id>          # dry run: lists targets
//   npx tsx scripts/reaudit-org.ts <org name or id> --run    # audits
//   npx tsx scripts/reaudit-org.ts <org name or id> --run --queue-analyses
//     # ...and queues a tariff_apply re-analysis for every analyzed entry
//     # whose open alerts changed (cleared, opened, or rewritten) — the AI
//     # findings that corroborated a stale alert persist until re-analyzed
//
// Runs against whatever DATABASE_URL points at (2026-09-11: ran against prod
// after the trust gate learned the block-37 AD/CVD convention; 2026-09-24:
// after the loader learned to inherit special-rates text).
import { and, eq } from "drizzle-orm";

import { queueReanalysesForEntries } from "../src/lib/analysis/service";
import { sweepAudits } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";

/** Open alerts keyed by (entry, alert_key) with their last write — the
 *  before/after snapshot that names which entries a sweep touched. */
async function openAlerts(orgId: string): Promise<Map<string, string>> {
  const rows = await db.query.auditAlerts.findMany({
    where: and(
      eq(schema.auditAlerts.orgId, orgId),
      eq(schema.auditAlerts.status, "open"),
    ),
    columns: { entryId: true, alertKey: true, updatedAt: true },
  });
  return new Map(
    rows.map((r) => [`${r.entryId}\u0000${r.alertKey}`, r.updatedAt.toISOString()]),
  );
}

function touchedEntries(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const entries = new Set<string>();
  for (const [key, at] of before) {
    if (after.get(key) !== at) entries.add(key.split("\u0000")[0]);
  }
  for (const key of after.keys()) {
    if (!before.has(key)) entries.add(key.split("\u0000")[0]);
  }
  return [...entries];
}

async function main() {
  const [target, ...flags] = process.argv.slice(2);
  const flag = flags.includes("--run") ? "--run" : null;
  const queueAnalyses = flags.includes("--queue-analyses");
  if (!target) {
    console.error(
      "usage: reaudit-org.ts <org name or id> [--run] [--queue-analyses]",
    );
    process.exit(1);
  }
  // A uuid targets the id column; anything else is a name (comparing a
  // name against the uuid column is a Postgres type error, not a miss).
  const isId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const org = await db.query.orgs.findFirst({
    where: isId.test(target)
      ? eq(schema.orgs.id, target)
      : eq(schema.orgs.name, target),
    columns: { id: true, name: true },
  });
  if (!org) {
    console.error(`No org named or keyed ${target}.`);
    process.exit(1);
  }
  const entries = await db.query.entries.findMany({
    where: eq(schema.entries.orgId, org.id),
    columns: { id: true },
  });
  console.log(`${org.name} (${org.id}): ${entries.length} entries`);
  if (flag !== "--run") {
    console.log("dry run — pass --run to re-audit");
    return;
  }
  const before = queueAnalyses ? await openAlerts(org.id) : null;
  const summary = await sweepAudits(db, org.id);
  console.log(
    `audited ${summary.entries} entries: ${summary.cleared} alerts cleared, ${summary.created} opened`,
  );
  if (before) {
    const touched = touchedEntries(before, await openAlerts(org.id));
    const queued = await queueReanalysesForEntries(db, touched);
    console.log(
      `${touched.length} entr${touched.length === 1 ? "y" : "ies"} with changed open alerts; ${queued} re-analysis run(s) queued (tariff_apply) — the sweep cron drains them`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
