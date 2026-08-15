// Eval harness for the AI entry analyst: run the analyst over seeded entries
// and grade the output three ways — (a) recall of the deterministic audit
// findings, (b) the planted analysis defects (seed-data/analysis-defects.ts),
// (c) novel findings listed for manual grading — with per-entry cost and
// latency. Read-only: nothing is written to the database.
//
// Run (stop the dev server first — PGlite is single-process):
//   npx tsx scripts/analyze-entry.ts 231-4501358-3     # one entry
//   npx tsx scripts/analyze-entry.ts --all             # every entry (real
//                                                      #   API spend with a key)
//   npx tsx scripts/analyze-entry.ts --all --stub      # force the stub —
//                                                      #   free, deterministic
// Env: ANTHROPIC_API_KEY selects the Claude analyst; ENTRY_ANALYST_MODEL,
// ENTRY_ANALYST_DEADLINE_MS, ENTRY_ANALYST_MAX_ITERATIONS tune it.
// Reports land in ./.analysis/<run>/<entryNumber>.{md,json}.
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { asc, eq, inArray } from "drizzle-orm";

// Relative imports on purpose: tsx does not resolve the `@/` alias here.
import { getEntryAnalyst } from "../src/lib/analysis";
import { loadEntryBundle } from "../src/lib/analysis/bundle";
import type { Finding } from "../src/lib/analysis/findings";
import { StubEntryAnalyst, alertToFinding } from "../src/lib/analysis/stub";
import type { AnalystResult } from "../src/lib/analysis/types";
import { computeEntryAlerts, type DesiredAlert } from "../src/lib/audit/rules";
import { db, schema } from "../src/lib/db";
import {
  PLANTED_ANALYSIS_DEFECTS,
  type PlantedAnalysisDefect,
} from "../src/lib/db/seed-data/analysis-defects";
import { loadReferenceDataForOrg } from "../src/lib/duty/reference";

// claude-opus-5 list pricing ($/MTok); cache read 0.1x input, write 1.25x.
// Re-verify against current pricing before trusting the dollar column.
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

type AlertGrade = {
  alertKey: string;
  hit: "key" | "fuzzy" | "miss";
  findingTitle: string | null;
};

type DefectGrade = {
  defect: PlantedAnalysisDefect;
  hit: boolean;
  findingTitle: string | null;
};

function gradeAlerts(
  desired: DesiredAlert[],
  findings: Finding[],
): { grades: AlertGrade[]; matched: Set<Finding> } {
  const matched = new Set<Finding>();
  const grades = desired.map((alert): AlertGrade => {
    const byKey = findings.find((f) => f.relatedAlertKeys.includes(alert.alertKey));
    if (byKey) {
      matched.add(byKey);
      return { alertKey: alert.alertKey, hit: "key", findingTitle: byKey.title };
    }
    const expected = alertToFinding(alert);
    const fuzzy = findings.find(
      (f) =>
        f.category === expected.category && f.lineNumber === expected.lineNumber,
    );
    if (fuzzy) {
      matched.add(fuzzy);
      return { alertKey: alert.alertKey, hit: "fuzzy", findingTitle: fuzzy.title };
    }
    return { alertKey: alert.alertKey, hit: "miss", findingTitle: null };
  });
  return { grades, matched };
}

function gradeDefects(
  entryNumber: string,
  findings: Finding[],
  matched: Set<Finding>,
): DefectGrade[] {
  return PLANTED_ANALYSIS_DEFECTS.filter(
    (d) => d.entryNumber === entryNumber,
  ).map((defect) => {
    const finding = findings.find(
      (f) =>
        defect.acceptedCategories.includes(f.category) &&
        (defect.lineNumber === null ||
          f.lineNumber === null ||
          f.lineNumber === defect.lineNumber),
    );
    if (finding) matched.add(finding);
    return { defect, hit: Boolean(finding), findingTitle: finding?.title ?? null };
  });
}

function estimateCost(u: AnalystResult["usage"]): number {
  return (
    (u.inputTokens * PRICE.input +
      u.outputTokens * PRICE.output +
      u.cacheReadInputTokens * PRICE.cacheRead +
      u.cacheCreationInputTokens * PRICE.cacheWrite) /
    1_000_000
  );
}

function renderMarkdown(args: {
  entryNumber: string;
  result: AnalystResult;
  alertGrades: AlertGrade[];
  defectGrades: DefectGrade[];
  novel: Finding[];
  wallMs: number;
}): string {
  const { entryNumber, result, alertGrades, defectGrades, novel, wallMs } = args;
  const { report, usage } = result;
  const hits = alertGrades.filter((g) => g.hit !== "miss").length;
  const lines: string[] = [
    `# Entry ${entryNumber} — analysis report`,
    "",
    `- Analyst: ${result.analyst}${result.error ? ` — ERROR: ${result.error}` : ""}`,
    `- Summary: ${report.summary}`,
    "",
    `## Findings (${report.findings.length})`,
    "",
  ];
  report.findings.forEach((f, i) => {
    lines.push(
      `### ${i + 1}. [${f.category} / ${f.severity}] ${f.title}`,
      `${f.lineNumber === null ? "Entry-level" : `Line ${f.lineNumber}`} · confidence ${f.confidence}${f.relatedAlertKeys.length ? ` · corroborates ${f.relatedAlertKeys.join(", ")}` : " · novel"}`,
      "",
      f.explanation,
      "",
      ...f.evidence.map(
        (e) =>
          `- evidence (${e.source}${e.documentId ? ` ${e.documentId}` : ""}${e.field ? ` · ${e.field}` : ""}): "${e.quote}"`,
      ),
      "",
      `Suggested action: ${f.suggestedAction}`,
      "",
    );
  });
  lines.push(
    `## (a) Deterministic recall: ${hits}/${alertGrades.length}`,
    "",
    ...alertGrades.map(
      (g) =>
        `- ${g.hit === "miss" ? "MISS" : `HIT (${g.hit})`} \`${g.alertKey}\`${g.findingTitle ? ` ← ${g.findingTitle}` : ""}`,
    ),
    "",
    `## (b) Planted defects: ${defectGrades.filter((d) => d.hit).length}/${defectGrades.length}`,
    "",
    ...defectGrades.map(
      (d) =>
        `- ${d.hit ? "HIT" : "MISS"} \`${d.defect.key}\`${d.findingTitle ? ` ← ${d.findingTitle}` : ""}\n  - expected: ${d.defect.description}`,
    ),
    "",
    `## (c) Novel findings for manual grading (${novel.length})`,
    "",
    ...(novel.length
      ? novel.map((f) => `- [${f.category}] ${f.title} (confidence ${f.confidence})`)
      : ["- (none)"]),
    "",
    "## Cost & latency",
    "",
    `- iterations: ${usage.iterations}`,
    `- tokens: in ${usage.inputTokens} · cache-read ${usage.cacheReadInputTokens} · cache-write ${usage.cacheCreationInputTokens} · out ${usage.outputTokens}`,
    `- estimated cost: $${estimateCost(usage).toFixed(4)}`,
    `- wall time: ${(wallMs / 1000).toFixed(1)}s`,
    "",
    `## Tool trace (${result.trace.length} calls)`,
    "",
    ...result.trace.map(
      (t) => `- ${t.tool}(${JSON.stringify(t.input)}) → ${t.resultPreview.slice(0, 120)}`,
    ),
    "",
  );
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const stub = args.includes("--stub");
  const entryNumbers = args.filter((a) => !a.startsWith("--"));
  if (!all && entryNumbers.length === 0) {
    console.error(
      "Usage: npx tsx scripts/analyze-entry.ts <entryNumber...> | --all [--stub]",
    );
    process.exit(1);
  }

  const org = await db.query.orgs.findFirst();
  if (!org) throw new Error("no org — run db:seed first");

  const entries = await db.query.entries.findMany({
    where: all
      ? eq(schema.entries.orgId, org.id)
      : inArray(schema.entries.entryNumber, entryNumbers),
    columns: { id: true, entryNumber: true },
    orderBy: [asc(schema.entries.entryDate)],
  });
  if (entries.length === 0) throw new Error("no matching entries");
  if (!all && entries.length < entryNumbers.length) {
    const found = new Set(entries.map((e) => e.entryNumber));
    const missing = entryNumbers.filter((n) => !found.has(n));
    throw new Error(`unknown entry number(s): ${missing.join(", ")}`);
  }

  const analyst = stub ? new StubEntryAnalyst() : getEntryAnalyst();
  const ref = await loadReferenceDataForOrg(db, org.id);

  const runDir = path.join(
    ".analysis",
    new Date().toISOString().slice(0, 19).replace(/[:]/g, "-"),
  );
  mkdirSync(runDir, { recursive: true });

  const totals = {
    entries: 0,
    findings: 0,
    alertHits: 0,
    alerts: 0,
    defectHits: 0,
    defects: 0,
    novel: 0,
    cost: 0,
    errors: 0,
  };

  for (const { id, entryNumber } of entries) {
    const bundle = await loadEntryBundle(db, org.id, id);
    if (!bundle) throw new Error(`bundle load failed for ${entryNumber}`);

    const started = Date.now();
    const result = await analyst.analyze(bundle, ref);
    const wallMs = Date.now() - started;

    const desired = computeEntryAlerts(bundle.snapshot.auditable, ref);
    const { grades: alertGrades, matched } = gradeAlerts(
      desired,
      result.report.findings,
    );
    const defectGrades = gradeDefects(
      entryNumber,
      result.report.findings,
      matched,
    );
    const novel = result.report.findings.filter((f) => !matched.has(f));

    const md = renderMarkdown({
      entryNumber,
      result,
      alertGrades,
      defectGrades,
      novel,
      wallMs,
    });
    writeFileSync(path.join(runDir, `${entryNumber}.md`), md);
    writeFileSync(
      path.join(runDir, `${entryNumber}.json`),
      JSON.stringify({ entryNumber, result, alertGrades, defectGrades, wallMs }, null, 2),
    );

    const hits = alertGrades.filter((g) => g.hit !== "miss").length;
    const cost = estimateCost(result.usage);
    totals.entries += 1;
    totals.findings += result.report.findings.length;
    totals.alertHits += hits;
    totals.alerts += alertGrades.length;
    totals.defectHits += defectGrades.filter((d) => d.hit).length;
    totals.defects += defectGrades.length;
    totals.novel += novel.length;
    totals.cost += cost;
    if (result.error) totals.errors += 1;

    console.log(
      `${entryNumber}  findings=${result.report.findings.length}  recall=${hits}/${alertGrades.length}  defects=${defectGrades.filter((d) => d.hit).length}/${defectGrades.length}  novel=${novel.length}  $${cost.toFixed(4)}  ${(wallMs / 1000).toFixed(1)}s${result.error ? `  ERROR: ${result.error}` : ""}`,
    );
  }

  console.log(
    `\n${totals.entries} entries · ${totals.findings} findings · recall ${totals.alertHits}/${totals.alerts} · defects ${totals.defectHits}/${totals.defects} · novel ${totals.novel} · est. $${totals.cost.toFixed(4)}${totals.errors ? ` · ${totals.errors} degraded run(s)` : ""}`,
  );
  console.log(`Reports: ${runDir}/`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
