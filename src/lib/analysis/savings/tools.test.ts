import { describe, expect, it } from "vitest";

import { day, fixtureRef as ref } from "../test-fixtures";
import type { SavingsReport } from "./report";
import {
  buildSavingsTools,
  matchesQuery,
  type SavingsCollector,
  type SavingsToolContext,
} from "./tools";
import type { PartBundle } from "./types";

function fixturePartBundle(over: Partial<PartBundle> = {}): PartBundle {
  return {
    orgId: "org1",
    part: {
      id: "p1",
      sku: "EB-MTR-500W",
      name: "500W hub motor",
      description: "Brushless 500W hub motor",
      status: "active",
      htsCode: "8501.31.4000",
      htsCodeProvisional: false,
      classifications: [
        { htsCode: "8501.31.4000", validFrom: null, validTo: null },
      ],
      sources: [
        {
          vendorName: "Shenzhen Drivetrain Co",
          countryOfOrigin: "CN",
          unitCost: "100",
          validFrom: null,
          validTo: null,
        },
      ],
    },
    history: [
      {
        entryNumber: "231-0000001-1",
        entryDate: day(-30),
        lineNumber: 1,
        htsCode: "8501.31.4000",
        countryOfOrigin: "CN",
        quantity: "100.0000",
        enteredValue: "10000.00",
        dutyCharges: [
          { chargeType: "base_duty", rate: "0.04", amount: "400.00" },
        ],
      },
    ],
    trailingEnteredValueCents: 1_000_000,
    countriesOfOrigin: ["CN"],
    ...over,
  };
}

function setup(bundle = fixturePartBundle()) {
  const ctx: SavingsToolContext = { bundle, ref, trace: [] };
  const collector: SavingsCollector = { report: null };
  const tools = buildSavingsTools(ctx, collector);
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

describe("matchesQuery", () => {
  it("requires every term, case-insensitively", () => {
    expect(matchesQuery("Lithium-ion storage batteries, other", "lithium batteries")).toBe(true);
    expect(matchesQuery("Lithium-ion storage batteries, other", "lithium saddles")).toBe(false);
  });
});

describe("buildSavingsTools", () => {
  it("exposes exactly the six planned tools", () => {
    const { byName } = setup();
    expect([...byName.keys()].sort()).toEqual([
      "compare_codes",
      "get_entry_history",
      "get_measures",
      "get_part_details",
      "report_opportunities",
      "search_schedule",
    ]);
  });

  it("search_schedule finds codes by description terms", async () => {
    const { run } = setup();
    const out = JSON.parse(
      await run("search_schedule", { query: "batteries", htsPrefix: null }),
    );
    expect(out.matches.length).toBeGreaterThan(0);
    expect(
      out.matches.every((m: { code: string }) => !m.code.startsWith("99")),
    ).toBe(true);
  });

  it("search_schedule scopes by prefix and errors on empty input", async () => {
    const { run } = setup();
    const out = JSON.parse(
      await run("search_schedule", { query: null, htsPrefix: "8501" }),
    );
    expect(
      out.matches.every((m: { code: string }) =>
        m.code.replace(/\D/g, "").startsWith("8501"),
      ),
    ).toBe(true);
    expect(
      await run("search_schedule", { query: null, htsPrefix: null }),
    ).toMatch(/^ERROR:/);
  });

  it("compare_codes prices codes on the trailing basis", async () => {
    const { run } = setup();
    const out = JSON.parse(
      await run("compare_codes", {
        codes: ["8501.31.4000"],
        countryOfOrigin: "CN",
        date: day(-30),
      }),
    );
    expect(out.basisCents).toBe(1_000_000);
    expect(out.basisIsFallback).toBe(false);
    expect(out.results[0].totalDutyCents).toBeGreaterThan(0);
  });

  it("compare_codes falls back to a synthetic basis with no history", async () => {
    const { run } = setup(
      fixturePartBundle({ history: [], trailingEnteredValueCents: 0 }),
    );
    const out = JSON.parse(
      await run("compare_codes", {
        codes: ["8501.31.4000"],
        countryOfOrigin: "CN",
        date: day(-30),
      }),
    );
    expect(out.basisIsFallback).toBe(true);
    expect(out.basisCents).toBeGreaterThan(0);
  });

  it("report_opportunities fills the collector", async () => {
    const { collector, run } = setup();
    const report: SavingsReport = { summary: "clean", opportunities: [] };
    const out = await run("report_opportunities", report);
    expect(out).toContain("Report recorded");
    expect(collector.report?.summary).toBe("clean");
  });
});
