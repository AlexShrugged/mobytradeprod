import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import { normalizeHts } from "../duty/calculator";
import type { ReferenceData } from "../duty/types";
import { computeEstimatedLandedCost, type EstimateInput } from "./estimate";

// Fixed anchor (2026-08-11) — see calculator.test.ts. AS_OF predates the
// Section 122 cutoff (day(-10) = 2026-08-01), so no surcharge components.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const ref = buildSeedReferenceData(day);
const AS_OF = "2026-06-10";

function part(
  htsCode: string | null,
  coo: string | null,
  unitCostCents: number | null,
): EstimateInput {
  return {
    unitCostCents,
    htsDigits: htsCode === null ? null : normalizeHts(htsCode),
    countryOfOrigin: coo,
  };
}

describe("computeEstimatedLandedCost", () => {
  it("CN motor stacks base 4% + 301 List 1 + reciprocal + MPF/HMF", () => {
    const result = computeEstimatedLandedCost(
      part("8501.31.4000", "CN", 14_800),
      ref,
      AS_OF,
    )!;

    const amounts = Object.fromEntries(
      result.components.map((c) => [c.label, c.amountCents]),
    );
    expect(amounts["Merchandise (unit cost)"]).toBe(14_800);
    expect(amounts["Base duty (4%)"]).toBe(592);
    expect(amounts["Section 301 List 1 — China (25%)"]).toBe(3_700);
    expect(amounts["IEEPA Reciprocal Tariff — baseline (10%)"]).toBe(1_480);
    expect(amounts["MPF (est.)"]).toBe(Math.round(0.003464 * 14_800));
    expect(amounts["HMF (est.)"]).toBe(Math.round(0.00125 * 14_800));

    expect(result.totalCents).toBe(14_800 + 592 + 3_700 + 1_480 + 51 + 19);
    expect(result.quantity).toBe(1);
    expect(result.perUnitCents).toBe(result.totalCents);
    expect(result.incomplete).toBe(false);
    expect(result.included).toEqual(["merchandise", "duty", "fee"]);
    expect(result.excluded).toEqual(["freight", "insurance", "brokerage"]);
  });

  it("TW aluminum frame gets 232 and no suppressed reciprocal component", () => {
    const result = computeEstimatedLandedCost(
      part("8714.91.3000", "TW", 10_000),
      ref,
      AS_OF,
    )!;

    const labels = result.components.map((c) => c.label);
    expect(labels).toContain("Section 232 Aluminum — derivative articles (25%)");
    expect(labels.some((l) => l.includes("Reciprocal"))).toBe(false);
    expect(result.totalCents).toBe(10_000 + 390 + 2_500 + 35 + 13);
  });

  it("VN tire pays only the reciprocal baseline over a free base rate", () => {
    const result = computeEstimatedLandedCost(
      part("4011.50.0000", "VN", 4_200),
      ref,
      AS_OF,
    )!;

    const dutyComponents = result.components.filter((c) => c.kind === "duty");
    expect(dutyComponents.map((c) => c.label)).toEqual([
      "Base duty (Free)",
      "IEEPA Reciprocal Tariff — baseline (10%)",
    ]);
    expect(result.totalCents).toBe(4_200 + 0 + 420 + 15 + 5);
  });

  it("returns null when unit cost or HTS is missing", () => {
    expect(
      computeEstimatedLandedCost(part("8501.31.4000", "CN", null), ref, AS_OF),
    ).toBeNull();
    expect(
      computeEstimatedLandedCost(part(null, "CN", 10_000), ref, AS_OF),
    ).toBeNull();
  });

  it("an HTS unknown to the reference schedule estimates incomplete, measures still apply", () => {
    const result = computeEstimatedLandedCost(
      part("0101.21.0010", "CN", 10_000),
      ref,
      AS_OF,
    )!;

    const base = result.components.find((c) => c.label === "Base duty")!;
    expect(base.amountCents).toBeNull();
    expect(base.note).toContain("not in the reference schedule");
    expect(result.incomplete).toBe(true);
    // Reciprocal is all-products/all-countries, so it still applies.
    expect(
      result.components.some((c) => c.label.includes("Reciprocal")),
    ).toBe(true);
  });

  it("a specific-rate base duty yields a null component and incomplete total", () => {
    const digits = normalizeHts("6403.91.6000");
    const synthetic: ReferenceData = {
      htsByDigits: new Map(ref.htsByDigits).set(digits, {
        code: "6403.91.6000",
        codeDigits: digits,
        description: "Footwear, welt, other",
        chapter: 64,
        rateType: "specific",
        rate: null,
        exemption: false,
        tradeMeasureId: null,
      }),
      measures: ref.measures,
      stackingRules: ref.stackingRules,
    };

    const result = computeEstimatedLandedCost(
      part("6403.91.6000", "VN", 10_000),
      synthetic,
      AS_OF,
    )!;

    const base = result.components.find((c) => c.label.startsWith("Base duty"))!;
    expect(base.amountCents).toBeNull();
    expect(result.incomplete).toBe(true);
    // Total still carries the computable parts.
    expect(result.totalCents).toBeGreaterThan(10_000);
  });

  it("includeFees: false drops MPF/HMF", () => {
    const result = computeEstimatedLandedCost(
      part("4011.50.0000", "VN", 4_200),
      ref,
      AS_OF,
      { includeFees: false },
    )!;

    expect(result.components.every((c) => c.kind !== "fee")).toBe(true);
    expect(result.included).not.toContain("fee");
    expect(result.totalCents).toBe(4_200 + 420);
  });
});
