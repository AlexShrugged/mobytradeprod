// Re-queue the entries whose LATEST analysis run failed on a transient
// Anthropic error — a credit outage or the workspace's usage limit. The
// sweep never retries a failed run (failed runs never reconcile findings,
// so nothing is damaged, but the entry stays stale until something queues
// it again). Fourth manual cleanup of this shape, 2026-09-24.
//
//   npx tsx scripts/requeue-failed-analyses.ts            # dry run
//   npx tsx scripts/requeue-failed-analyses.ts --apply
//   npx tsx scripts/requeue-failed-analyses.ts --error "credit balance"
//
// Default match: "usage limits" OR "credit balance" in the run's error. An
// entry with a pending or running row is left alone (it will run anyway).
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { sql } from "drizzle-orm";

// Relative imports on purpose: tsx does not resolve the `@/` alias here.
import { queueAnalysesForEntries } from "../src/lib/analysis/service";
import { db } from "../src/lib/db";

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function option(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

type Row = {
  entry_id: string;
  org_id: string;
  entry_number: string;
  org: string;
  finished_at: string;
  error: string;
};

async function main() {
  const apply = flag("--apply");
  const custom = option("--error");
  const patterns = custom ? [custom] : ["usage limits", "credit balance"];
  const like = sql.join(
    patterns.map((p) => sql`latest.error ilike ${"%" + p + "%"}`),
    sql` or `,
  );
  const result = (await db.execute(sql`
    with latest as (
      select distinct on (r.entry_id)
        r.entry_id, r.org_id, r.status, r.error, r.finished_at
      from analysis_runs r
      order by r.entry_id, r.created_at desc
    )
    select latest.entry_id, latest.org_id, e.entry_number, o.name as org,
           latest.finished_at, left(latest.error, 100) as error
    from latest
    join entries e on e.id = latest.entry_id
    join orgs o on o.id = latest.org_id
    where latest.status = 'failed' and (${like})
    order by o.name, e.entry_number
  `)) as unknown as { rows: Row[] };
  const stale = result.rows;
  for (const r of stale) {
    console.log(
      `${r.org.padEnd(8)} ${r.entry_number} failed ${new Date(r.finished_at).toISOString()}  ${r.error}`,
    );
  }
  console.log(
    `${stale.length} entries whose latest run failed on ${patterns.map((p) => JSON.stringify(p)).join(" / ")}${apply ? "" : " (dry run — pass --apply to queue)"}`,
  );
  if (!apply || stale.length === 0) return;
  const queued = await queueAnalysesForEntries(
    db,
    stale.map((r) => ({ entryId: r.entry_id, orgId: r.org_id })),
    "entry_change",
  );
  console.log(`queued ${queued} new pending rows`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
