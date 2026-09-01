// One-time repair for packet children ingested before the tariff_code_sheet
// pipeline existed: children split under packet_role 'hts_code_list' were
// typed doc_type 'other' (no extraction pipeline), so the broker's
// line↔part mapping sheets — ASC's "ENTRY TARIFF CODE SHEET" pages — were
// parsed and then discarded unstructured.
//
// This flips those children to doc_type 'tariff_code_sheet' so a reprocess
// runs the new typed extraction and the linker persists entry_line_parts.
// It changes NO extracted data itself — the rows only appear once each
// document is reprocessed (needs the Reducto key on the runtime; the
// Data page's Reprocess action or a sweep both work).
//
// Requires migration 0022 (the enum value): run db:migrate first.
//
//   DATABASE_URL=... npx tsx scripts/retype-tariff-code-sheets.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/retype-tariff-code-sheets.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq } from "drizzle-orm";

import { db, schema } from "../src/lib/db";

const APPLY = process.argv.includes("--apply");

async function main() {
  const targets = await db.query.documents.findMany({
    where: and(
      eq(schema.documents.packetRole, "hts_code_list"),
      eq(schema.documents.docType, "other"),
    ),
    columns: { id: true, fileName: true, status: true },
  });

  console.log(
    `${APPLY ? "Retyping" : "Would retype"} ${targets.length} packet children ` +
      `(packet_role hts_code_list, doc_type other) to tariff_code_sheet:`,
  );
  for (const doc of targets) {
    console.log(`  ${doc.id}  [${doc.status}]  ${doc.fileName}`);
  }

  if (APPLY && targets.length > 0) {
    await db.transaction(async (tx) => {
      for (const doc of targets) {
        await tx
          .update(schema.documents)
          .set({ docType: "tariff_code_sheet", updatedAt: new Date() })
          .where(eq(schema.documents.id, doc.id));
      }
    });
    console.log(
      "Done. Reprocess these documents to extract and persist the line↔part rows.",
    );
  } else if (!APPLY) {
    console.log("Dry run — pass --apply to write.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
