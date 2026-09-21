// Bring the Section 232 column of a catalog file an org ALREADY imported
// into parts.section_232 — for catalogs uploaded before the importer read
// that column (it was silently dropped). Reads ONLY that column, through
// the importer's own parser, so header polarity ("232 Exempt") and the
// blank-is-not-a-no rule are identical to a fresh import. Deliberately not
// a re-import: a bulk file's HTS code differing from a committed one is a
// reclassification dated today (parts/import-service.ts), and an old file
// must not overwrite what the importer has edited since.
//
//   npx tsx scripts/backfill-section-232.ts <org name or id> <file>
//   npx tsx scripts/backfill-section-232.ts <org name or id> <file> --apply
//   npx tsx scripts/backfill-section-232.ts <org name or id> <file> --apply --queue-analyses
//
// Dry run by default. The file is checked against the org's part_catalog
// documents by name and size, so a stray spreadsheet cannot be applied.
// Only a stated answer writes; a part already carrying the same mark is
// left alone. Every write records a field_changes row (source
// catalog_import). --queue-analyses re-queues the AI analysis of the
// analyzed entries carrying a changed SKU (one pending row per entry, so
// it composes with any other re-queue).
//
// Runs against whatever DATABASE_URL points at.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import { and, eq, inArray } from "drizzle-orm";

import { queueReanalysesForParts } from "../src/lib/analysis/service";
import { db, schema } from "../src/lib/db";
import {
  extractCatalogItems,
  extractFromSheets,
  parseCsv,
} from "../src/lib/parts/import-file";
import { readXlsxTables } from "../src/lib/parts/import-xlsx";
import { section232ToCell } from "../src/lib/parts/section-232";
import { buildSkuIndex, normalizeSku, resolveSku } from "../src/lib/parts/sku";
import { skuKeySql } from "../src/lib/parts/sku-sql";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [target, filePath] = args.filter((a) => !a.startsWith("--"));
  if (!target || !filePath) {
    console.error(
      "usage: backfill-section-232.ts <org name or id> <file> [--apply] [--queue-analyses]",
    );
    process.exit(1);
  }

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

  const fileName = basename(filePath);
  const fileSize = statSync(filePath).size;
  const stored = await db.query.documents.findFirst({
    where: and(
      eq(schema.documents.orgId, org.id),
      eq(schema.documents.docType, "part_catalog"),
      eq(schema.documents.fileName, fileName),
      eq(schema.documents.fileSize, fileSize),
    ),
    columns: { id: true, uploadedAt: true },
  });
  if (!stored) {
    console.error(
      `${org.name} has no part_catalog document named "${fileName}" of ${fileSize} bytes — refusing to apply a file the org never imported.`,
    );
    process.exit(1);
  }
  console.log(
    `${org.name} (${org.id}): "${fileName}" matches catalog document ${stored.id}, uploaded ${stored.uploadedAt.toISOString()}`,
  );

  const buffer = readFileSync(filePath);
  const extracted = /\.xlsx$/i.test(fileName)
    ? extractFromSheets(await readXlsxTables(buffer))
    : extractCatalogItems(parseCsv(buffer.toString("utf8")));
  if (extracted.columns.section232 === undefined) {
    console.error(
      `No Section 232 column in the file (columns mapped: ${JSON.stringify(extracted.columns)}).`,
    );
    process.exit(1);
  }
  const marked = extracted.items.filter((i) => i.section232 !== null);
  console.log(
    `column "${extracted.columns.section232}": ${extracted.items.length} SKUs, ${marked.filter((i) => i.section232).length} applies, ${marked.filter((i) => i.section232 === false).length} does not apply, ${extracted.items.length - marked.length} not specified`,
  );
  const columnIssues = extracted.issues.filter((i) =>
    i.message.startsWith("Section 232"),
  );
  for (const issue of columnIssues.slice(0, 20)) {
    console.log(`  row ${issue.row}: ${issue.message}`);
  }

  const parts: schema.Part[] = [];
  for (let i = 0; i < marked.length; i += 5000) {
    parts.push(
      ...(await db.query.parts.findMany({
        where: and(
          eq(schema.parts.orgId, org.id),
          inArray(
            skuKeySql(schema.parts.sku),
            marked.slice(i, i + 5000).map((item) => normalizeSku(item.sku)),
          ),
        ),
      })),
    );
  }
  const index = buildSkuIndex(parts);

  const changes: { part: schema.Part; value: boolean }[] = [];
  const unmatched: string[] = [];
  let same = 0;
  for (const item of marked) {
    const part = resolveSku(index, item.sku);
    if (!part) {
      unmatched.push(item.sku);
    } else if (part.section232 === item.section232) {
      same++;
    } else {
      changes.push({ part, value: item.section232 as boolean });
    }
  }
  const overwrites = changes.filter((c) => c.part.section232 !== null);
  console.log(
    `${changes.length} to set (${overwrites.length} overwrite an existing mark), ${same} already set, ${unmatched.length} not in the catalog${
      unmatched.length ? `: ${unmatched.slice(0, 10).join(", ")}` : ""
    }`,
  );
  for (const c of overwrites.slice(0, 20)) {
    console.log(
      `  ${c.part.sku}: ${section232ToCell(c.part.section232)} → ${section232ToCell(c.value)}`,
    );
  }

  if (!flags.has("--apply")) {
    console.log("dry run — pass --apply to write");
    return;
  }

  const queued = await db.transaction(async (tx) => {
    for (const c of changes) {
      await tx
        .update(schema.parts)
        .set({ section232: c.value, updatedAt: new Date() })
        .where(eq(schema.parts.id, c.part.id));
    }
    for (let i = 0; i < changes.length; i += 500) {
      await tx.insert(schema.fieldChanges).values(
        changes.slice(i, i + 500).map((c) => ({
          orgId: org.id,
          entityType: "part" as const,
          entityId: c.part.id,
          field: "section_232",
          oldValue: section232ToCell(c.part.section232),
          newValue: section232ToCell(c.value),
          source: "catalog_import",
          note: `Backfilled from ${fileName}`,
        })),
      );
    }
    return flags.has("--queue-analyses")
      ? queueReanalysesForParts(
          tx,
          org.id,
          changes.map((c) => c.part.id),
        )
      : null;
  });
  console.log(
    `set ${changes.length} parts${queued === null ? "" : `, queued ${queued} re-analyses`}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
