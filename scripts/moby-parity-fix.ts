// Moby-parity pass over the live reference, following the 2026-08-17 bulk
// approval: bring in the legacy platform's prefix-scoped measures (301
// lists, 232 copper), retire staging that is stale against the live 2026
// reference, upgrade coarse metal prefixes to moby's precise mappings, and
// tile the two rate histories moby's data corrects (CN fentanyl 20%->10%,
// CA border 25%->35%). Route-parity approvals: same transaction shape and
// single-writer functions as PATCH /api/tariff-sync/revisions/[id].
//
//   DATABASE_URL=... npx tsx scripts/moby-parity-fix.ts        # dry run
//   DATABASE_URL=... npx tsx scripts/moby-parity-fix.ts --apply
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { and, eq, inArray } from "drizzle-orm";

import { sweepAuditsAllOrgs } from "../src/lib/audit/auditor";
import { db, schema } from "../src/lib/db";
import type { DbClient } from "../src/lib/duty/reference";
import {
  applyRevision,
  ApplyValidationError,
  resolveAnnouncementIfTerminal,
} from "../src/lib/tariff-sync/apply";
import type { ProposedMeasureChange } from "../src/lib/tariff-sync/types";

const DECIDED_BY = "alex@countless.ai — moby parity pass 2026-08-17";
const DROP_FROM_8804 = new Set(["94016960", "94037040", "94017100"]);
const DROP_FROM_8815 = new Set(["94016960", "94017100"]);

// code -> {program (null = clear), worldwide, dropPrefixes}
const APPROVE: Record<
  string,
  { program: string | null; worldwide?: boolean; drop?: Set<string> }
> = {
  "9903.88.01": { program: "section-301-china" },
  "9903.88.02": { program: "section-301-china" },
  "9903.88.03": { program: "section-301-china" },
  "9903.88.04": { program: "section-301-china", drop: DROP_FROM_8804 },
  "9903.88.15": { program: "section-301-china", drop: DROP_FROM_8815 },
  "9903.88.69": { program: null },
  "9903.78.01": { program: "section-232-copper", worldwide: true },
  "9903.78.02": { program: null },
};
const APPROVE_ORDER = [
  "9903.88.01", "9903.88.02", "9903.88.03", "9903.88.69",
  "9903.88.04", "9903.88.15", "9903.78.01", "9903.78.02",
];

// Live measures whose prefix sets get replaced by moby's precise mappings.
const METALS_CSV = "data/lookups/section_232_metals_2026_mappings.csv";
const UPGRADE_CODES = ["9903.82.02", "9903.82.04", "9903.82.14", "9903.85.67"];

// Rate-history tiling: split one live window into predecessor + successor.
const TILINGS = [
  {
    code: "9903.01.24", // CN/HK IEEPA fentanyl: 20% until the Nov 10 2025 truce
    firstRate: "0.200000",
    firstEnd: "2025-11-09",
    secondRate: "0.100000",
    secondFrom: "2025-11-10",
  },
  {
    code: "9903.01.10", // CA IEEPA border: 25% until the Aug 1 2025 increase
    firstRate: "0.250000",
    firstEnd: "2025-07-31",
    secondRate: "0.350000",
    secondFrom: "2025-08-01",
  },
];

class Rollback extends Error {}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

async function run(tx: DbClient, mobyDir: string, log: (m: string) => void) {
  // ---- 1. Reject the unprefixed snapshot 990388 group (301 lists come
  //         from moby with real product scoping instead).
  const groups = await tx.query.measureRevisionGroups.findMany({
    where: eq(schema.measureRevisionGroups.ch99Prefix, "990388"),
  });
  for (const g of groups) {
    const item = await tx.query.reviewItems.findFirst({
      where: and(
        eq(schema.reviewItems.itemType, "tariff_measure_group"),
        eq(schema.reviewItems.subjectId, g.id),
        eq(schema.reviewItems.status, "pending"),
      ),
    });
    if (!item) continue;
    await tx
      .update(schema.reviewItems)
      .set({
        status: "rejected",
        resolutionAction: "reject",
        decidedBy: DECIDED_BY,
        decidedAt: new Date(),
        notes:
          "Replaced by the moby legacy import: snapshot members carry no product scoping (all-products China would over-charge every line); moby's Lists 1-4 measures apply with note-20 prefix lists.",
        updatedAt: new Date(),
      })
      .where(eq(schema.reviewItems.id, item.id));
    await resolveAnnouncementIfTerminal(tx, g.announcementId);
    log(`rejected snapshot group 990388 (${g.id})`);
  }

  // ---- 2. Approve the moby measures worth applying.
  const ann = await tx.query.tariffAnnouncements.findFirst({
    where: and(
      eq(schema.tariffAnnouncements.source, "manual"),
      eq(schema.tariffAnnouncements.sourceRef, "legacy-moby-import"),
    ),
  });
  if (!ann) throw new Error("legacy-moby-import announcement missing");
  const revs = await tx.query.measureRevisions.findMany({
    where: eq(schema.measureRevisions.announcementId, ann.id),
  });
  const byCode = new Map(revs.filter((r) => !r.appliedAt && !r.supersededAt).map((r) => [r.ch99Code, r]));

  for (const code of APPROVE_ORDER) {
    const rev = byCode.get(code);
    if (!rev) throw new Error(`staged revision for ${code} not found`);
    const spec = APPROVE[code];
    const proposed = { ...(rev.proposed as ProposedMeasureChange) };
    proposed.program = spec.program;
    if (spec.worldwide) proposed.worldwide = true;
    if (spec.drop) {
      proposed.prefixes = proposed.prefixes.filter((p) => !spec.drop!.has(digitsOnly(p)));
    }
    await tx
      .update(schema.measureRevisions)
      .set({ proposed, updatedAt: new Date() })
      .where(eq(schema.measureRevisions.id, rev.id));
    const item = await tx.query.reviewItems.findFirst({
      where: and(
        eq(schema.reviewItems.itemType, "tariff_measure_revision"),
        eq(schema.reviewItems.subjectId, rev.id),
      ),
    });
    if (item?.status !== "pending") throw new Error(`item for ${code} not pending`);
    await tx
      .update(schema.reviewItems)
      .set({
        status: "approved",
        resolutionAction: "accept",
        decidedBy: DECIDED_BY,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.reviewItems.id, item.id));
    const applied = await applyRevision(tx, rev.id);
    log(
      `applied ${code} (${proposed.name}) prefixes=${proposed.prefixes.length}` +
        (applied!.superseded.length > 0
          ? ` !! SUPERSEDED: ${applied!.superseded.map((s) => s.ch99Code).join(",")}`
          : ""),
    );
    if (applied!.superseded.length > 0) {
      throw new ApplyValidationError(`unexpected supersede applying ${code} — aborting`);
    }
  }

  // ---- 3. Reject the remaining stale legacy proposals.
  const leftover = revs.filter(
    (r) => !APPROVE[r.ch99Code ?? ""] && !r.appliedAt && !r.supersededAt,
  );
  if (leftover.length > 0) {
    const items = await tx.query.reviewItems.findMany({
      where: and(
        eq(schema.reviewItems.itemType, "tariff_measure_revision"),
        inArray(schema.reviewItems.subjectId, leftover.map((r) => r.id)),
        eq(schema.reviewItems.status, "pending"),
      ),
    });
    for (const item of items) {
      await tx
        .update(schema.reviewItems)
        .set({
          status: "rejected",
          resolutionAction: "reject",
          decidedBy: DECIDED_BY,
          decidedAt: new Date(),
          notes:
            "Stale against the live 2026 reference (April-2025-era moby snapshot, missing product scoping, or moby-era code mapping that conflicts with the current schedule). The live windows approved 2026-08-17 stand.",
          updatedAt: new Date(),
        })
        .where(eq(schema.reviewItems.id, item.id));
    }
    log(`rejected ${items.length} stale legacy proposal(s)`);
  }
  await resolveAnnouncementIfTerminal(tx, ann.id);

  // ---- 4. Upgrade live metal measures' prefixes from moby's mapping.
  const csv = readFileSync(join(mobyDir, METALS_CSV), "utf8").split(/\r?\n/);
  const header = csv[0].split(",").map((h) => h.trim());
  const codeIdx = header.indexOf("Chapter99_HTS");
  const baseIdx = header.indexOf("General_HTS");
  const prefixByCode = new Map<string, Set<string>>();
  for (const line of csv.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    const code = (cells[codeIdx] ?? "").trim();
    const base = digitsOnly(cells[baseIdx] ?? "");
    if (!code || !base) continue;
    (prefixByCode.get(code) ?? prefixByCode.set(code, new Set()).get(code)!).add(
      base.slice(0, 10),
    );
  }
  for (const code of UPGRADE_CODES) {
    const prefixes = prefixByCode.get(code);
    if (!prefixes || prefixes.size === 0) {
      log(`no mapping rows for ${code} — skipped`);
      continue;
    }
    const htsRow = await tx.query.htsCodes.findFirst({
      where: and(
        eq(schema.htsCodes.codeDigits, digitsOnly(code)),
        eq(schema.htsCodes.exemption, false),
      ),
    });
    if (!htsRow?.tradeMeasureId) {
      log(`live measure for ${code} not found — skipped`);
      continue;
    }
    await tx
      .delete(schema.tradeMeasureHts)
      .where(eq(schema.tradeMeasureHts.tradeMeasureId, htsRow.tradeMeasureId));
    await tx.insert(schema.tradeMeasureHts).values(
      [...prefixes].map((htsPrefix) => ({
        tradeMeasureId: htsRow.tradeMeasureId!,
        htsPrefix,
      })),
    );
    log(`upgraded ${code} prefixes -> ${prefixes.size} precise rows`);
  }

  // ---- 5. Rate-history tiling (predecessor window + successor measure).
  for (const t of TILINGS) {
    const digits = digitsOnly(t.code);
    const liabilityRows = await tx.query.htsCodes.findMany({
      where: and(
        eq(schema.htsCodes.codeDigits, digits),
        eq(schema.htsCodes.exemption, false),
      ),
    });
    const measureIds = liabilityRows
      .map((h) => h.tradeMeasureId)
      .filter((id): id is string => id !== null);
    const measures =
      measureIds.length > 0
        ? await tx.query.tradeMeasures.findMany({
            where: inArray(schema.tradeMeasures.id, measureIds),
          })
        : [];
    if (measures.length !== 1) {
      log(`tiling ${t.code}: expected exactly 1 live window, found ${measures.length} — skipped`);
      continue;
    }
    const m = measures[0];
    const hts = liabilityRows.find((h) => h.tradeMeasureId === m.id)!;
    const originalEnd = m.endDate;
    await tx
      .update(schema.tradeMeasures)
      .set({ endDate: t.firstEnd, updatedAt: new Date() })
      .where(eq(schema.tradeMeasures.id, m.id));
    await tx
      .update(schema.htsCodes)
      .set({ rate: t.firstRate, updatedAt: new Date() })
      .where(eq(schema.htsCodes.id, hts.id));
    const [successor] = await tx
      .insert(schema.tradeMeasures)
      .values({
        name: m.name,
        authority: m.authority,
        program: m.program,
        scope: m.scope,
        countries: m.countries,
        countriesExcluded: m.countriesExcluded,
        effectiveDate: t.secondFrom,
        endDate: originalEnd,
        sailedOnOrAfter: null,
        sailedOnOrBefore: null,
        inLieuOfBaseDuty: m.inLieuOfBaseDuty,
        notes: `Rate-history tiling (moby parity): predecessor window ${m.effectiveDate}..${t.firstEnd} at ${t.firstRate}.`,
        predecessorId: m.id,
      })
      .returning();
    await tx.insert(schema.htsCodes).values({
      code: hts.code,
      codeDigits: hts.codeDigits,
      description: hts.description,
      chapter: 99,
      rateType: hts.rateType,
      rate: t.secondRate,
      tradeMeasureId: successor.id,
      exemption: false,
    });
    log(
      `tiled ${t.code}: ${m.effectiveDate}..${t.firstEnd} @ ${t.firstRate} -> ${t.secondFrom}..${originalEnd} @ ${t.secondRate}`,
    );
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mobyDir = resolve(process.cwd(), process.env.MOBY_DIR ?? "../moby");
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
    console.log(m);
  };
  try {
    await db.transaction(async (tx) => {
      await run(tx, mobyDir, log);
      if (!apply) throw new Rollback();
    });
  } catch (err) {
    if (err instanceof Rollback) {
      console.log("\nDRY RUN — rolled back, nothing written.");
      return;
    }
    throw err;
  }
  const audit = await sweepAuditsAllOrgs(db);
  console.log("\nAPPLIED. audit sweep:", JSON.stringify(audit));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
