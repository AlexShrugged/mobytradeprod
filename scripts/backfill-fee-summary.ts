// Backfill Block 43 fee facts onto processed 7501s whose extraction predates
// processing/fee-summary.ts (2026-09-17). The parse text is already stored on
// every row, so no Reducto credit is spent: parse the "Other Fee Summary"
// block, rewrite the document's extracted_data (fee_summary + the header
// mpf_amount/hmf_amount as collected), and carry the collected figures onto
// the linked entry's header the way the linker would (the latest processed
// 7501 of an entry wins). Touched entries are re-audited (rule 17 reconciles
// by alert_key) and, where the header moved, queued for an entry_change
// re-analysis so the analyst re-reads the corrected facts and its stale
// fee_error findings reconcile away on the clean run.
//
//   DATABASE_URL=... npx tsx scripts/backfill-fee-summary.ts                # dry run
//   DATABASE_URL=... npx tsx scripts/backfill-fee-summary.ts --apply
//   DATABASE_URL=... npx tsx scripts/backfill-fee-summary.ts --apply --reaudit-all
//   DATABASE_URL=... npx tsx scripts/backfill-fee-summary.ts --apply --skip-reaudit
//
// --reaudit-all sweeps every entry of every org afterwards (rule 17's first
// pass over the book, not just the touched entries); --skip-reaudit writes
// the facts and queues the analyses but leaves the audit to a later
// reaudit-org run — the choice when the local rules are ahead of the
// deployed schema (the mpf_bounds enum value must exist before an alert of
// that type can be inserted). Ran against prod 2026-09-17 with
// --skip-reaudit ahead of the deploy. tsx runs this as CJS — no top-level
// await; everything lives in main().

import { and, asc, eq } from "drizzle-orm";

import { queueAnalysesForEntries } from "../src/lib/analysis/service";
import {
  sweepAuditsAllOrgs,
  sweepAuditsForEntries,
} from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import { parseFeeSummary } from "../src/lib/processing/fee-summary";
import { parseResultText } from "../src/lib/processing/line-sku";
import type {
  PortEntryExtraction,
  RawExtraction,
} from "../src/lib/processing/types";

type DocPlan = {
  docId: string;
  orgId: string;
  fileName: string;
  entryNumber: string;
  before: { mpf: number | null; hmf: number | null };
  after: { mpf: number; hmf: number };
  fields: PortEntryExtraction;
  entryIds: string[];
};

const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `$${v.toFixed(2)}`;

async function main() {
  const apply = process.argv.includes("--apply");
  const reauditAll = process.argv.includes("--reaudit-all");

  const docs = await db.query.documents.findMany({
    where: and(
      eq(schema.documents.docType, "port_entry"),
      eq(schema.documents.status, "processed"),
    ),
    columns: { id: true, orgId: true, fileName: true, processedAt: true },
    orderBy: [asc(schema.documents.processedAt)],
  });
  console.log(`${docs.length} processed 7501(s)`);

  const plans: DocPlan[] = [];
  let noText = 0;
  let noBlock = 0;
  let unchanged = 0;
  for (const d of docs) {
    // One row at a time: raw_extraction runs to megabytes per document.
    const full = await db.query.documents.findFirst({
      where: eq(schema.documents.id, d.id),
      columns: { extractedData: true, rawExtraction: true },
    });
    const raw = (full?.rawExtraction ?? null) as RawExtraction | null;
    const text = raw ? parseResultText(raw.parse?.result) : "";
    if (!text) {
      noText += 1;
      continue;
    }
    const parsed = parseFeeSummary(text);
    if (!parsed) {
      noBlock += 1;
      continue;
    }
    const fields = full?.extractedData as PortEntryExtraction;
    const amount = (code: string) =>
      parsed.rows.find((r) => r.code === code)?.amount ?? 0;
    const after = { mpf: amount("499"), hmf: amount("501") };
    const before = { mpf: fields.mpf_amount, hmf: fields.hmf_amount };
    const sameRows =
      JSON.stringify(fields.fee_summary ?? null) === JSON.stringify(parsed.rows);
    if (sameRows && before.mpf === after.mpf && before.hmf === after.hmf) {
      unchanged += 1;
      continue;
    }
    const links = await db.query.documentLinks.findMany({
      where: and(
        eq(schema.documentLinks.documentId, d.id),
        eq(schema.documentLinks.entityType, "entry"),
      ),
      columns: { entityId: true },
    });
    plans.push({
      docId: d.id,
      orgId: d.orgId,
      fileName: d.fileName,
      entryNumber: fields.entry_number,
      before,
      after,
      fields: {
        ...fields,
        fee_summary: parsed.rows,
        mpf_amount: after.mpf,
        hmf_amount: after.hmf,
      },
      entryIds: links.map((l) => l.entityId),
    });
  }

  console.log(
    `${plans.length} to update, ${unchanged} already carrying Block 43, ${noBlock} with no parseable block, ${noText} with no parse text`,
  );
  for (const p of plans) {
    const moved =
      p.before.mpf !== p.after.mpf || p.before.hmf !== p.after.hmf;
    console.log(
      `${moved ? "HEADER" : "rows  "} ${p.entryNumber}  MPF ${money(p.before.mpf)} → ${money(p.after.mpf)}  HMF ${money(p.before.hmf)} → ${money(p.after.hmf)}  (${p.fileName}, ${p.entryIds.length} entry link(s))`,
    );
  }
  if (!apply) {
    console.log("\nDRY RUN — pass --apply to write.");
    return;
  }

  // Documents first, then the entry headers in processed order so the
  // latest 7501 of an entry wins, as the linker's header rule would have it.
  const touched = new Map<string, { entryId: string; orgId: string }>();
  const headerMoved = new Map<string, { entryId: string; orgId: string }>();
  for (const p of plans) {
    await db
      .update(schema.documents)
      .set({ extractedData: p.fields })
      .where(eq(schema.documents.id, p.docId));
    for (const entryId of p.entryIds) {
      const current = await db.query.entries.findFirst({
        where: eq(schema.entries.id, entryId),
        columns: { mpfAmount: true, hmfAmount: true },
      });
      if (!current) continue;
      const mpf = p.after.mpf.toFixed(2);
      const hmf = p.after.hmf.toFixed(2);
      touched.set(entryId, { entryId, orgId: p.orgId });
      if (current.mpfAmount === mpf && current.hmfAmount === hmf) continue;
      await db
        .update(schema.entries)
        .set({ mpfAmount: mpf, hmfAmount: hmf, updatedAt: new Date() })
        .where(eq(schema.entries.id, entryId));
      headerMoved.set(entryId, { entryId, orgId: p.orgId });
    }
  }
  console.log(
    `\nAPPLIED: ${plans.length} document(s) rewritten, ${headerMoved.size} entry header(s) moved`,
  );

  if (process.argv.includes("--skip-reaudit")) {
    console.log("audit sweep skipped (--skip-reaudit); run reaudit-org later");
  } else {
    const audit = reauditAll
      ? await sweepAuditsAllOrgs(db)
      : await sweepAuditsForEntries(db, [...touched.values()]);
    console.log("audit sweep:", JSON.stringify(audit));
  }

  const queued = await queueAnalysesForEntries(
    db,
    [...headerMoved.values()],
    "entry_change",
  );
  console.log(`${queued} entry_change analysis run(s) queued`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
