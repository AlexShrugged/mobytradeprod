// Eval/run harness for the part-scoped HTS-savings analyst: run it over
// catalog parts and write per-part reports with cost and latency. Phase-1
// like the entry analyst's first cut: nothing persists — reports land on
// disk for human grading.
//
// Run (stop the dev server first — PGlite is single-process):
//   npx tsx scripts/hts-savings.ts EB-BAT-48V          # one SKU
//   npx tsx scripts/hts-savings.ts --all               # every active part
//                                                      #   with a committed
//                                                      #   code (real spend)
//   npx tsx scripts/hts-savings.ts --all --stub        # free, empty stub
// Env: ANTHROPIC_API_KEY selects the Claude analyst; SAVINGS_ANALYST_MODEL
// (falls back to ENTRY_ANALYST_MODEL), ENTRY_ANALYST_DEADLINE_MS,
// ENTRY_ANALYST_MAX_ITERATIONS tune it.
// Reports land in ./.analysis/savings/<run>/<sku>.{md,json}.
//
// tsx runs this as CJS — no top-level await; everything lives in main().

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { and, eq, inArray } from "drizzle-orm";

// Relative imports on purpose: tsx does not resolve the `@/` alias here.
import { loadPartBundle } from "../src/lib/analysis/savings/bundle";
import {
  getSavingsAnalyst,
  StubSavingsAnalyst,
} from "../src/lib/analysis/savings";
import type { SavingsResult } from "../src/lib/analysis/savings/types";
import { db, schema } from "../src/lib/db";
import { loadReferenceDataForOrg } from "../src/lib/duty/reference";

// claude-opus-5 list pricing ($/MTok); cache read 0.1x input, write 1.25x.
// Re-verify against current pricing before trusting the dollar column.
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

function estimateCost(u: SavingsResult["usage"]): number {
  return (
    (u.inputTokens * PRICE.input +
      u.outputTokens * PRICE.output +
      u.cacheReadInputTokens * PRICE.cacheRead +
      u.cacheCreationInputTokens * PRICE.cacheWrite) /
    1_000_000
  );
}

const fmtCents = (c: number) => `$${(c / 100).toFixed(2)}`;

function renderMarkdown(args: {
  sku: string;
  currentHts: string | null;
  result: SavingsResult;
  wallMs: number;
}): string {
  const { sku, currentHts, result, wallMs } = args;
  const { report, usage } = result;
  const lines: string[] = [
    `# ${sku} — HTS savings review`,
    "",
    `- Analyst: ${result.analyst}${result.error ? ` — ERROR: ${result.error}` : ""}`,
    `- Current code: ${currentHts ?? "(none committed)"}`,
    `- Summary: ${report.summary}`,
    "",
    `## Opportunities (${report.opportunities.length})`,
    "",
  ];
  report.opportunities.forEach((o, i) => {
    lines.push(
      `### ${i + 1}. ${o.candidateHtsCode} — ${o.title}`,
      `Estimated annual savings: ${o.estimatedAnnualSavingsCents === null ? "not estimable" : fmtCents(o.estimatedAnnualSavingsCents)} · confidence ${o.confidence}`,
      "",
      o.rationale,
      "",
      `Risks: ${o.risks}`,
      "",
      ...o.evidence.map(
        (e) => `- evidence (${e.source}${e.field ? ` · ${e.field}` : ""}): "${e.quote}"`,
      ),
      "",
      `Suggested action: ${o.suggestedAction}`,
      "",
    );
  });
  lines.push(
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
      (t) =>
        `- ${t.tool}(${JSON.stringify(t.input)}) → ${t.resultPreview.slice(0, 120)}`,
    ),
    "",
  );
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const stub = args.includes("--stub");
  const skus = args.filter((a) => !a.startsWith("--"));
  if (!all && skus.length === 0) {
    console.error(
      "Usage: npx tsx scripts/hts-savings.ts <SKU...> | --all [--stub]",
    );
    process.exit(1);
  }

  const org = await db.query.orgs.findFirst();
  if (!org) throw new Error("no org — run db:seed first");

  const parts = await db.query.parts.findMany({
    where: all
      ? and(
          eq(schema.parts.orgId, org.id),
          eq(schema.parts.status, "active"),
          eq(schema.parts.htsCodeProvisional, false),
        )
      : and(eq(schema.parts.orgId, org.id), inArray(schema.parts.sku, skus)),
    columns: { id: true, sku: true, htsCode: true, htsCodeProvisional: true },
    orderBy: (t, { asc }) => [asc(t.sku)],
  });
  const targets = all ? parts.filter((p) => p.htsCode !== null) : parts;
  if (targets.length === 0) throw new Error("no matching parts");
  if (!all && targets.length < skus.length) {
    const found = new Set(targets.map((p) => p.sku));
    const missing = skus.filter((s) => !found.has(s));
    throw new Error(`unknown SKU(s): ${missing.join(", ")}`);
  }

  const analyst = stub ? new StubSavingsAnalyst() : getSavingsAnalyst();
  const ref = await loadReferenceDataForOrg(db, org.id);

  const runDir = path.join(
    ".analysis",
    "savings",
    new Date().toISOString().slice(0, 19).replace(/[:]/g, "-"),
  );
  mkdirSync(runDir, { recursive: true });

  let totalCost = 0;
  let totalOpportunities = 0;
  for (const p of targets) {
    const bundle = await loadPartBundle(db, org.id, p.id);
    if (!bundle) throw new Error(`bundle load failed for ${p.sku}`);

    const started = Date.now();
    const result = await analyst.analyze(bundle, ref);
    const wallMs = Date.now() - started;

    const md = renderMarkdown({
      sku: p.sku,
      currentHts: bundle.part.htsCode,
      result,
      wallMs,
    });
    writeFileSync(path.join(runDir, `${p.sku}.md`), md);
    writeFileSync(
      path.join(runDir, `${p.sku}.json`),
      JSON.stringify({ sku: p.sku, result, wallMs }, null, 2),
    );

    const cost = estimateCost(result.usage);
    totalCost += cost;
    totalOpportunities += result.report.opportunities.length;
    console.log(
      `${p.sku}  opportunities=${result.report.opportunities.length}  $${cost.toFixed(4)}  ${(wallMs / 1000).toFixed(1)}s${result.error ? `  ERROR: ${result.error}` : ""}`,
    );
  }

  console.log(
    `\n${targets.length} part(s) · ${totalOpportunities} opportunit${totalOpportunities === 1 ? "y" : "ies"} · est. $${totalCost.toFixed(4)}`,
  );
  console.log(`Reports: ${runDir}/`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
