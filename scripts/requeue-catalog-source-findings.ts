// Re-queue the entries carrying an open AI finding measured against a
// catalog sourcing record — a declared origin the catalog's source does not
// carry, or a seller/manufacturer of record who is not the catalog vendor.
// The analyst no longer raises that class (a catalog source is a known
// source, never the SKU's only origin — prompt doctrine, 2026-10-01), but an
// open finding only withdraws on a clean re-run.
//
//   npx tsx scripts/requeue-catalog-source-findings.ts            # dry run
//   npx tsx scripts/requeue-catalog-source-findings.ts --apply
//   npx tsx scripts/requeue-catalog-source-findings.ts --only 231-7393968-4 --apply
//
// The class sits in four finding categories, so the match is on wording: any
// open coo_inconsistency finding that cites the catalog, plus findings of
// other categories whose title sets the catalog against a vendor, seller,
// producer or manufacturer. A superset is harmless (one extra analysis). An
// entry already pending keeps its one row. Run it only while the Anthropic
// account has credit: the sweep never retries a failed run.
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
  findings: number;
};

async function main() {
  const apply = flag("--apply");
  const only = option("--only");
  const result = (await db.execute(sql`
    select f.entry_id, f.org_id, e.entry_number, o.name as org,
           count(*)::int as findings
    from analysis_findings f
    join entries e on e.id = f.entry_id
    join orgs o on o.id = f.org_id
    where f.status = 'open'
      and (f.title ilike '%catalog%' or f.fields::text ilike '%catalog%')
      and (
        f.category = 'coo_inconsistency'
        or (
          f.category <> 'classification_mismatch'
          and f.title ~* '(vendor|seller|sourc|producer|supplier|manufacturer|invoicing party)'
          and f.title !~* '(HTS|classif|232)'
        )
      )
    group by f.entry_id, f.org_id, e.entry_number, o.name
    order by o.name, e.entry_number
  `)) as unknown as { rows: Row[] };
  const targets = result.rows.filter((r) => !only || r.entry_number === only);
  for (const r of targets) {
    console.log(`${r.org.padEnd(8)} ${r.entry_number}  ${r.findings} finding(s)`);
  }
  console.log(
    `${targets.length} entries with an open catalog-source finding${apply ? "" : " (dry run — pass --apply to queue)"}`,
  );
  if (!apply || targets.length === 0) return;
  const queued = await queueAnalysesForEntries(
    db,
    targets.map((r) => ({ entryId: r.entry_id, orgId: r.org_id })),
    "manual",
  );
  console.log(`queued ${queued} new pending rows`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
