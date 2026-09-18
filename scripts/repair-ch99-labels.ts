// Repair Chapter 99 reference labels staged before the sync read a heading's
// program from its FAMILY and carried the schedule's own words onto the row.
// Diagnosed 2026-09-18 from an ASC complaint ("9903.05.90 is not pharma"):
//
//   1. AUTHORITY. The differ's last-resort product cue read "pharmaceutical"
//      anywhere in the article text, so the note 52 carve-out for everything
//      Section 232 already covers (9903.05.90 — aluminum, steel, copper,
//      derivatives, vehicles, wood, patented pharma, semiconductors), its
//      Brazil twin (9903.05.07) and the two pharmaceutical-USE exemptions
//      (9903.05.06/.89) were all staged "Section 232 Pharma". An exemption
//      heading belongs to the program it exempts from: this step finds every
//      exemption-only measure whose authority disagrees with the authority
//      its 6-digit family's liability headings agree on, and moves it there.
//      Names are rewritten only when they are still the synthesized
//      "<label> — <code>"; a reviewer-edited name is never touched. Open
//      (unapplied, unsuperseded) revisions of those codes are re-pointed too,
//      so approving one cannot bring the label back.
//
//   2. DESCRIPTION. insertCh99Row stored the measure NAME as the Chapter 99
//      row's description, so get_measures and the assistant had nothing but
//      our label to reason from — and the differ, which compares the release
//      text against that description, re-staged a phantom note_change for
//      every sync-created heading. Each labeled row takes the article text
//      of the latest APPLIED revision of its code (approval-gated text only:
//      an unreviewed wording change stays a real note_change for a human).
//
// Neither step touches duty math: authority is a display bucket, never the
// exclusivity key, and exemption-only measures never enter the calculator.
// What DOES move is the analyst's reading, so --queue-analyses re-runs the
// previously analyzed entries that declare a relabeled code.
//
//   DATABASE_URL=... npx tsx scripts/repair-ch99-labels.ts                          # dry run
//   DATABASE_URL=... npx tsx scripts/repair-ch99-labels.ts --apply
//   DATABASE_URL=... npx tsx scripts/repair-ch99-labels.ts --apply --queue-analyses
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { queueReanalysesForEntries } from "../src/lib/analysis/service";
import { db, schema } from "../src/lib/db";
import type { MeasureAuthorityValue } from "../src/lib/db/schema";
import type { DbClient } from "../src/lib/duty/reference";
import { AUTHORITY_LABEL } from "../src/lib/tariff-sync/differ";
import type {
  ProposedMeasureChange,
  RevisionEvidence,
} from "../src/lib/tariff-sync/types";

class Rollback extends Error {}

type Outcome = { relabeledCodes: string[] };

const labelFor = (authority: MeasureAuthorityValue, code: string) =>
  `${AUTHORITY_LABEL[authority]} — ${code}`;

async function run(tx: DbClient, log: (m: string) => void): Promise<Outcome> {
  const [ch99Rows, measures] = await Promise.all([
    tx.query.htsCodes.findMany({
      where: and(
        eq(schema.htsCodes.chapter, 99),
        isNotNull(schema.htsCodes.tradeMeasureId),
      ),
    }),
    tx.query.tradeMeasures.findMany(),
  ]);
  const measureById = new Map(measures.map((m) => [m.id, m]));

  // ---- 1. authority: exemption-only measures vs their family -------------
  // A measure's OWN heading is the row whose code its staged name ends with
  // (family link copies hang other codes off the same measure).
  const familyAuthorities = new Map<string, Set<MeasureAuthorityValue>>();
  const ownExemptions: { code: string; measureId: string; family: string }[] = [];
  for (const h of ch99Rows) {
    const m = measureById.get(h.tradeMeasureId!);
    if (!m) continue;
    const family = h.codeDigits.slice(0, 6);
    if (!h.exemption) {
      const set = familyAuthorities.get(family) ?? new Set();
      set.add(m.authority);
      familyAuthorities.set(family, set);
    } else if (m.name.endsWith(h.code)) {
      ownExemptions.push({ code: h.code, measureId: m.id, family });
    }
  }

  log("1. exemption headings filed under the wrong authority");
  const relabeledCodes: string[] = [];
  for (const ex of ownExemptions.sort((a, b) => a.code.localeCompare(b.code))) {
    const agreed = familyAuthorities.get(ex.family);
    if (!agreed || agreed.size !== 1) continue; // split family decides nothing
    const target = [...agreed][0];
    const m = measureById.get(ex.measureId)!;
    if (m.authority === target) continue;
    const synthesized = m.name === labelFor(m.authority, ex.code);
    const name = synthesized ? labelFor(target, ex.code) : m.name;
    log(
      `   ${ex.code}: ${m.authority} -> ${target}; name "${m.name}" -> ` +
        (synthesized ? `"${name}"` : "kept (reviewer-edited)"),
    );
    await tx
      .update(schema.tradeMeasures)
      .set({ authority: target, name, updatedAt: new Date() })
      .where(eq(schema.tradeMeasures.id, m.id));

    const open = await tx.query.measureRevisions.findMany({
      where: and(
        eq(schema.measureRevisions.ch99Code, ex.code),
        isNull(schema.measureRevisions.appliedAt),
        isNull(schema.measureRevisions.supersededAt),
      ),
    });
    for (const rev of open) {
      const proposed = rev.proposed as ProposedMeasureChange;
      await tx
        .update(schema.measureRevisions)
        .set({
          authority: target,
          proposed: {
            ...proposed,
            authority: target,
            name: proposed.name === m.name ? name : proposed.name,
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.measureRevisions.id, rev.id));
    }
    if (open.length > 0) log(`      + ${open.length} open revision(s) re-pointed`);
    relabeledCodes.push(ex.code);
  }
  if (relabeledCodes.length === 0) log("   none");

  // ---- 2. description: the schedule's words, not our label ---------------
  const applied = await tx.query.measureRevisions.findMany({
    where: and(
      isNotNull(schema.measureRevisions.ch99Code),
      isNotNull(schema.measureRevisions.appliedAt),
    ),
  });
  const textByCode = new Map<string, { text: string; at: Date }>();
  for (const rev of applied) {
    const text = (rev.evidence as RevisionEvidence | null)?.description?.trim();
    if (!text || !rev.appliedAt) continue;
    const cur = textByCode.get(rev.ch99Code!);
    if (!cur || rev.appliedAt > cur.at) {
      textByCode.set(rev.ch99Code!, { text, at: rev.appliedAt });
    }
  }

  // A row is "labeled" when its description is a measure name — the old
  // insert's signature. Hand-written descriptions (seed, legacy import) stay.
  const measureNames = new Set(measures.map((m) => m.name));
  const byText = new Map<string, string[]>();
  let labeled = 0;
  let noText = 0;
  const codesFixed = new Set<string>();
  for (const h of ch99Rows) {
    if (!measureNames.has(h.description)) continue;
    labeled += 1;
    const text = textByCode.get(h.code)?.text;
    if (!text) {
      noText += 1;
      continue;
    }
    byText.set(text, [...(byText.get(text) ?? []), h.id]);
    codesFixed.add(h.code);
  }
  for (const [text, ids] of byText) {
    for (let i = 0; i < ids.length; i += 500) {
      await tx
        .update(schema.htsCodes)
        .set({ description: text, updatedAt: new Date() })
        .where(inArray(schema.htsCodes.id, ids.slice(i, i + 500)));
    }
  }
  log("\n2. Chapter 99 rows described by a measure label");
  log(
    `   ${labeled} labeled row(s): ${labeled - noText} take the published text ` +
      `(${codesFixed.size} heading(s)), ${noText} have no applied schedule text and stay`,
  );
  for (const code of relabeledCodes) {
    log(`   ${code}: "${(textByCode.get(code)?.text ?? "(no text)").slice(0, 110)}…"`);
  }
  return { relabeledCodes };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const queueAnalyses = args.includes("--queue-analyses");
  const log = (m: string) => console.log(m);

  let outcome: Outcome = { relabeledCodes: [] };
  try {
    await db.transaction(async (tx) => {
      outcome = await run(tx, log);
      if (!apply) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  // Entries declaring a relabeled code: the analyst argued from the label.
  const digits = outcome.relabeledCodes.map((c) => c.replace(/\D/g, ""));
  const reach =
    digits.length === 0
      ? []
      : await db
          .selectDistinct({ entryId: schema.entryLineItems.entryId })
          .from(schema.entryLineCharges)
          .innerJoin(
            schema.entryLineItems,
            eq(schema.entryLineItems.id, schema.entryLineCharges.lineItemId),
          )
          .where(inArray(schema.entryLineCharges.htsCodeDigits, digits));
  console.log(
    `\n${reach.length} entr${reach.length === 1 ? "y declares" : "ies declare"} a relabeled code`,
  );

  if (!apply) {
    console.log("DRY RUN — rolled back, nothing written.");
    return;
  }
  console.log("APPLIED.");
  if (queueAnalyses) {
    const queued = await queueReanalysesForEntries(
      db,
      reach.map((r) => r.entryId),
    );
    console.log(`${queued} re-analysis run(s) queued (tariff_apply) — the sweep cron drains them`);
  } else {
    console.log(
      "AI findings citing the old label persist until re-analyzed — re-run with --queue-analyses.",
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
