// Backfill the column-27 Special Program Indicator onto 7501 lines whose
// extraction predates processing/line-spi.ts (2026-09-24). The parse text is
// already stored on every row, so no Reducto credit is spent: read each
// blank line's symbol from where the page prints it (else from a declared
// USMCA heading), rewrite the document's extracted_data, and carry the
// symbol onto the linked entry's line rows the way the linker would (a row
// is matched by line number and HTS digits and only ever filled, never
// overwritten). Touched entries are re-audited (the base-duty rules turn on
// the claim: MotoRad's 139 "declared 0%; the official rate is X%" alerts on
// Israeli and Mexican lines) and queued for an entry_change re-analysis so
// the analyst re-reads the claim and its stale findings reconcile away on
// the clean run.
//
//   DATABASE_URL=... npx tsx scripts/backfill-line-spi.ts                # dry run
//   DATABASE_URL=... npx tsx scripts/backfill-line-spi.ts --apply
//   DATABASE_URL=... npx tsx scripts/backfill-line-spi.ts --apply --skip-reaudit
//
// --skip-reaudit writes the facts and queues the analyses but leaves the
// audit to a later reaudit-org run. tsx runs this as CJS — no top-level
// await; everything lives in main().

import { and, asc, eq, isNull } from "drizzle-orm";

import { queueAnalysesForEntries } from "../src/lib/analysis/service";
import { sweepAuditsForEntries } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import { normalizeHts } from "../src/lib/duty/calculator";
import { parseResultText } from "../src/lib/processing/line-sku";
import { fillEntryLineSpis } from "../src/lib/processing/line-spi";
import type {
  PortEntryExtraction,
  RawExtraction,
} from "../src/lib/processing/types";

type LineFill = { lineNumber: number; htsCode: string; spi: string; coo: string | null };
type DocPlan = {
  docId: string;
  orgId: string;
  orgName: string;
  entryNumber: string;
  fills: LineFill[];
  fields: PortEntryExtraction;
  entryIds: string[];
};

async function main() {
  const apply = process.argv.includes("--apply");
  const skipReaudit = process.argv.includes("--skip-reaudit");

  const orgs = await db.query.orgs.findMany({ columns: { id: true, name: true } });
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const docs = await db.query.documents.findMany({
    where: and(
      eq(schema.documents.docType, "port_entry"),
      eq(schema.documents.status, "processed"),
    ),
    columns: { id: true, orgId: true, processedAt: true },
    orderBy: [asc(schema.documents.processedAt)],
  });
  console.log(`${docs.length} processed 7501(s)`);

  const plans: DocPlan[] = [];
  let noText = 0;
  let unchanged = 0;
  for (const d of docs) {
    // One row at a time: raw_extraction runs to megabytes per document.
    const full = await db.query.documents.findFirst({
      where: eq(schema.documents.id, d.id),
      columns: { extractedData: true, rawExtraction: true },
    });
    const raw = (full?.rawExtraction ?? null) as RawExtraction | null;
    const text = raw ? parseResultText(raw.parse?.result) : "";
    if (!text) noText += 1;
    const fields = full?.extractedData as PortEntryExtraction | null;
    if (!fields?.line_items) continue;
    const after = fillEntryLineSpis(fields, text || null);
    if (after === fields) {
      unchanged += 1;
      continue;
    }
    const fills: LineFill[] = [];
    after.line_items.forEach((line, i) => {
      const before = fields.line_items[i];
      if (line.spi && !before.spi) {
        fills.push({
          lineNumber: line.line_number,
          htsCode: line.hts_code,
          spi: line.spi,
          coo: line.country_of_origin,
        });
      }
    });
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
      orgName: orgName.get(d.orgId) ?? d.orgId,
      entryNumber: fields.entry_number,
      fills,
      fields: after,
      entryIds: links.map((l) => l.entityId),
    });
  }

  const totalFills = plans.reduce((n, p) => n + p.fills.length, 0);
  const bySymbol = new Map<string, number>();
  for (const p of plans) {
    for (const f of p.fills) {
      const k = `${p.orgName} ${f.spi} (${f.coo ?? "no COO"})`;
      bySymbol.set(k, (bySymbol.get(k) ?? 0) + 1);
    }
  }
  console.log(
    `${plans.length} document(s) to update with ${totalFills} line symbol(s); ${unchanged} unchanged; ${noText} without parse text`,
  );
  for (const [k, n] of [...bySymbol].sort()) console.log(`  ${k}: ${n}`);
  for (const p of plans) {
    console.log(
      `${p.orgName} ${p.entryNumber}: ${p.fills.map((f) => `L${f.lineNumber} ${f.htsCode} → ${f.spi}`).join(", ")} (${p.entryIds.length} entry link(s))`,
    );
  }
  if (!apply) {
    console.log("\nDRY RUN — pass --apply to write.");
    return;
  }

  const touched = new Map<string, { entryId: string; orgId: string }>();
  let rowsFilled = 0;
  for (const p of plans) {
    await db
      .update(schema.documents)
      .set({ extractedData: p.fields })
      .where(eq(schema.documents.id, p.docId));
    for (const entryId of p.entryIds) {
      for (const f of p.fills) {
        const res = await db
          .update(schema.entryLineItems)
          .set({ spi: f.spi, updatedAt: new Date() })
          .where(
            and(
              eq(schema.entryLineItems.entryId, entryId),
              eq(schema.entryLineItems.lineNumber, f.lineNumber),
              eq(schema.entryLineItems.htsCodeDigits, normalizeHts(f.htsCode)),
              isNull(schema.entryLineItems.spi),
            ),
          )
          .returning({ id: schema.entryLineItems.id });
        if (res.length > 0) {
          rowsFilled += res.length;
          touched.set(entryId, { entryId, orgId: p.orgId });
        }
      }
    }
  }
  console.log(
    `\nAPPLIED: ${plans.length} document(s) rewritten, ${rowsFilled} entry line row(s) filled on ${touched.size} entr${touched.size === 1 ? "y" : "ies"}`,
  );
  if (touched.size === 0) return;
  if (skipReaudit) {
    console.log("audit sweep skipped (--skip-reaudit); run reaudit-org later");
  } else {
    const audit = await sweepAuditsForEntries(db, [...touched.values()]);
    console.log("audit sweep:", JSON.stringify(audit));
  }
  const queued = await queueAnalysesForEntries(
    db,
    [...touched.values()],
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
