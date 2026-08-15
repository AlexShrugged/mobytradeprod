import { describe, expect, it } from "vitest";

import type { FindingsReport } from "./findings";
import { fixtureBundle, fixtureRef as ref } from "./test-fixtures";
import {
  buildAnalystTools,
  type ReportCollector,
  type ToolContext,
} from "./tools";

function setup(bundle = fixtureBundle()) {
  const ctx: ToolContext = { bundle, ref, trace: [] };
  const collector: ReportCollector = { report: null };
  const tools = buildAnalystTools(ctx, collector);
  const byName = new Map(
    tools.map((t) => [(t as { name: string }).name, t] as const),
  );
  const run = async (name: string, input: unknown): Promise<string> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return (await tool.run(input)) as string;
  };
  return { ctx, collector, run, byName };
}

describe("buildAnalystTools", () => {
  it("exposes exactly the eight planned tools", () => {
    const { byName } = setup();
    expect([...byName.keys()].sort()).toEqual([
      "get_adcvd_orders",
      "get_deterministic_findings",
      "get_expected_charges",
      "get_measures",
      "get_part",
      "get_regulatory_params",
      "read_document",
      "report_findings",
    ]);
  });

  it("read_document returns the extraction and traces the call", async () => {
    const { ctx, run } = setup();
    const out = JSON.parse(await run("read_document", { documentId: "d1" }));
    expect(out.extractedData.entry_type).toBe("03");
    expect(ctx.trace).toHaveLength(1);
    expect(ctx.trace[0].tool).toBe("read_document");
  });

  it("read_document errors usefully on an unknown id", async () => {
    const { run } = setup();
    const out = await run("read_document", { documentId: "nope" });
    expect(out).toMatch(/^ERROR:/);
    expect(out).toContain("d1");
  });

  it("get_expected_charges computes the deterministic expectation", async () => {
    const { run } = setup();
    const out = JSON.parse(await run("get_expected_charges", { lineNumber: 1 }));
    expect(out.baseDuty).not.toBeNull();
    expect(Array.isArray(out.measures)).toBe(true);
    expect(out.measures.length).toBeGreaterThan(0);
  });

  it("get_expected_charges errors on an unknown line", async () => {
    const { run } = setup();
    expect(await run("get_expected_charges", { lineNumber: 9 })).toMatch(
      /^ERROR:/,
    );
  });

  it("get_measures answers counterfactuals and defaults the date", async () => {
    const { run } = setup();
    const out = JSON.parse(
      await run("get_measures", {
        hts: "8501.31.4000",
        countryOfOrigin: "CN",
        date: null,
      }),
    );
    expect(out.htsDigits).toBe("8501314000");
    expect(out.baseSchedule).not.toBeNull();
    expect(out.applicable.length).toBeGreaterThan(0);
  });

  it("get_part returns catalog data and errors on unknown SKUs", async () => {
    const { run } = setup();
    const part = JSON.parse(await run("get_part", { sku: "EB-MTR-500W" }));
    expect(part.name).toBe("500W hub motor");
    expect(await run("get_part", { sku: "NOPE" })).toMatch(/^ERROR:/);
  });

  it("get_deterministic_findings runs the audit rules", async () => {
    const { run } = setup();
    const alerts = JSON.parse(await run("get_deterministic_findings", {}));
    expect(Array.isArray(alerts)).toBe(true);
    // The fixture line declares base duty only — the missing CN measures fire.
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toHaveProperty("alertKey");
  });

  it("get_regulatory_params returns FY figures plus the declared fees", async () => {
    const { run } = setup();
    const out = JSON.parse(await run("get_regulatory_params", { date: null }));
    expect(out.fiscalYear).toBe(2026);
    expect(out.mpf.minCents).toBe(3358);
    expect(out.declaredOnThisEntry.mpfAmount).toBe("34.64");
  });

  it("get_adcvd_orders filters by case number", async () => {
    const { run } = setup();
    const out = JSON.parse(
      await run("get_adcvd_orders", {
        caseNumber: "a-570-121",
        countryOfOrigin: null,
        htsPrefix: null,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].merchandise).toContain("Battery");
    expect(out[0].depositRates.find((r: { producer: string | null }) => r.producer === null).rate).toBe(0.2547);
  });

  it("get_adcvd_orders matches HTS prefixes in either direction", async () => {
    const { run } = setup();
    // A full 10-digit code matches the order's 6-digit prefix…
    const byCode = JSON.parse(
      await run("get_adcvd_orders", {
        caseNumber: null,
        countryOfOrigin: "CN",
        htsPrefix: "8507.60.0020",
      }),
    );
    expect(byCode.map((o: { caseNumber: string }) => o.caseNumber)).toEqual([
      "A-570-121",
    ]);
    // …and a bare chapter prefix matches the order's longer one.
    const byChapter = JSON.parse(
      await run("get_adcvd_orders", {
        caseNumber: null,
        countryOfOrigin: null,
        htsPrefix: "8501",
      }),
    );
    expect(byChapter.map((o: { caseNumber: string }) => o.caseNumber)).toEqual([
      "A-570-133",
    ]);
  });

  it("get_adcvd_orders lists known cases on a miss", async () => {
    const { run } = setup();
    const out = await run("get_adcvd_orders", {
      caseNumber: "A-570-999",
      countryOfOrigin: null,
      htsPrefix: null,
    });
    expect(out).toContain("No matching order");
    expect(out).toContain("A-570-121");
  });

  it("report_findings fills the collector", async () => {
    const { collector, run } = setup();
    const report: FindingsReport = { summary: "clean", findings: [] };
    const out = await run("report_findings", report);
    expect(out).toContain("Findings recorded");
    expect(collector.report?.summary).toBe("clean");
  });

  it("caps oversized tool results with a truncation note", async () => {
    const bundle = fixtureBundle();
    bundle.documents[0].extractedData = { blob: "x".repeat(60_000) };
    const { run } = setup(bundle);
    const out = await run("read_document", { documentId: "d1" });
    expect(out.length).toBeLessThan(25_000);
    expect(out).toContain("truncated");
  });
});
