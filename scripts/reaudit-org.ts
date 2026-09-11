// Re-run the deterministic audit over every entry of one org, in place —
// the follow-up to an audit-rule change that no document or tariff event
// re-triggers on its own (the auditor only re-audits an entry when its
// bundle or the reference data it touches moves). The sweep reconciles by
// alert_key: stale open alerts close, new findings open, resolved and
// dismissed rows are never touched.
//
//   npx tsx scripts/reaudit-org.ts <org name or id>          # dry run: lists targets
//   npx tsx scripts/reaudit-org.ts <org name or id> --run    # audits
//
// Runs against whatever DATABASE_URL points at (2026-09-11: ran against prod
// after the trust gate learned the block-37 AD/CVD convention).
import { eq } from "drizzle-orm";

import { sweepAudits } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";

async function main() {
  const [target, flag] = process.argv.slice(2);
  if (!target) {
    console.error("usage: reaudit-org.ts <org name or id> [--run]");
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
  const summary = await sweepAudits(db, org.id);
  console.log(
    `audited ${summary.entries} entries: ${summary.cleared} alerts cleared, ${summary.created} opened`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
