// One-time repair for prod entry 231-8933060-5 (ASC): the 7501 declares a
// $0 Section 232 no-alu/steel-content exclusion (9903.82.01 "DOES NOT
// CONTAIN ANY ALU, STL," FREE 0.00) on line 1's continuation sheet, but the
// Reducto extract pass dropped that stacked row — the structured line came
// back with only the base duty and the 9903.05.93 IEEPA-Canada claim — so
// audit Rule 1 raised a false "Missing Trade measure — 9903.82.02"
// (-$13,105.50). The reference side is correct (the metals-2026 measure's
// exclusionDigits carries 99038201 via family linkage); only the declared
// fact is missing. Inserts the charge row verbatim from the document, then
// re-audits THIS entry only (a full sweep is unnecessary and, pre-deploy,
// unsafe against prod's audit_alert_type enum). Idempotent: skips the
// insert when the charge already exists. The extract-pass prompt fix that
// prevents recurrence lives in reducto/schemas.ts.
//
//   DATABASE_URL=... npx tsx scripts/repair-8933060-dropped-exclusion.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/repair-8933060-dropped-exclusion.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { eq } from "drizzle-orm";

import { auditEntry } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import type { DbClient } from "../src/lib/duty/reference";

const ENTRY_NUMBER = "231-8933060-5";
const ORG_ID = "01a01aa9-2703-7128-b6a7-2e133a99c23c";
const DROPPED = { htsCode: "9903.82.01", htsCodeDigits: "99038201" };
// The sibling charge the extract DID capture — a shape check that we are
// looking at the entry this repair was written against.
const SIBLING_DIGITS = "99030593";

class Rollback extends Error {}

async function listAlerts(tx: DbClient, entryId: string) {
  const alerts = await tx.query.auditAlerts.findMany({
    where: eq(schema.auditAlerts.entryId, entryId),
  });
  return alerts.map((a) => `${a.alertKey} [${a.status}]`).sort();
}

async function run(tx: DbClient, log: (m: string) => void): Promise<void> {
  const entry = await tx.query.entries.findFirst({
    where: eq(schema.entries.entryNumber, ENTRY_NUMBER),
    with: {
      lineItems: { with: { charges: true }, orderBy: (li, { asc }) => [asc(li.lineNumber)] },
    },
  });
  if (!entry) throw new Error(`entry ${ENTRY_NUMBER} not found`);
  if (entry.orgId !== ORG_ID) {
    throw new Error(`entry ${ENTRY_NUMBER} belongs to org ${entry.orgId}, expected ${ORG_ID}`);
  }
  const line = entry.lineItems.find((li) => li.lineNumber === 1);
  if (!line) throw new Error("line 1 not found");
  if (!line.charges.some((c) => c.htsCodeDigits === SIBLING_DIGITS)) {
    throw new Error(
      `line 1 carries no ${SIBLING_DIGITS} charge — entry shape does not match ` +
        "the document this repair was written against; review by hand",
    );
  }

  log(`alerts before: ${(await listAlerts(tx, entry.id)).join(", ") || "(none)"}`);

  if (line.charges.some((c) => c.htsCodeDigits === DROPPED.htsCodeDigits)) {
    log(`line 1 already carries ${DROPPED.htsCode} — insert skipped`);
  } else {
    await tx.insert(schema.entryLineCharges).values({
      orgId: ORG_ID,
      lineItemId: line.id,
      chargeType: "additional_duty",
      htsCode: DROPPED.htsCode,
      htsCodeDigits: DROPPED.htsCodeDigits,
      rate: null,
      amount: "0.00",
    });
    log(`inserted additional_duty $0.00 @ ${DROPPED.htsCode} on line 1 (${line.id})`);
  }

  await auditEntry(tx, ORG_ID, entry.id);
  log(`alerts after re-audit: ${(await listAlerts(tx, entry.id)).join(", ") || "(none)"}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const log = (m: string) => console.log(m);
  try {
    await db.transaction(async (tx) => {
      await run(tx, log);
      if (!apply) throw new Rollback();
    });
  } catch (err) {
    if (err instanceof Rollback) {
      console.log("\nDRY RUN — rolled back, nothing written.");
      return;
    }
    throw err;
  }
  console.log("\nAPPLIED.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
