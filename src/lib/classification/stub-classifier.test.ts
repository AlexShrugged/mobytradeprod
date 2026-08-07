import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import { StubClassifier } from "./stub-classifier";
import type { ClassifyInput } from "./types";

// Fixed anchor (2026-08-11) — see calculator.test.ts. The classifier never
// reads measure windows; the anchor exists only because the seed builder
// parameterizes its sail-tiled measures on the run day.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const ref = buildSeedReferenceData(day);
const classifier = new StubClassifier();

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    sku: "SKU-X",
    name: "A part",
    description: null,
    countriesOfOrigin: ["CN"],
    currentHtsCode: null,
    ...over,
  };
}

describe("StubClassifier", () => {
  it("is deterministic — same input, identical output", async () => {
    const a = await classifier.classify(
      input({ sku: "EB-MTR-500W", currentHtsCode: "8501.31.4000" }),
      ref,
    );
    const b = await classifier.classify(
      input({ sku: "EB-MTR-500W", currentHtsCode: "8501.31.4000" }),
      ref,
    );
    expect(a).toEqual(b);
  });

  it("never proposes chapter 98/99 codes", async () => {
    const skus: [string, string | null][] = [
      ["EB-BRK-HYD", "8714.94.3080"],
      ["EB-CTRL-V2", "8504.40.9550"],
      ["EB-WHL-27F", "8714.92.1000"],
      ["RANDOM-SKU", "8714.99.8000"],
    ];
    for (const [sku, code] of skus) {
      const result = await classifier.classify(
        input({ sku, currentHtsCode: code }),
        ref,
      );
      for (const c of result.candidates) {
        expect(Number(c.codeDigits.slice(0, 2))).toBeLessThan(98);
      }
    }
  });

  it("ranks candidates densely from position 0 with descending story order preserved", async () => {
    const result = await classifier.classify(
      input({ sku: "EB-CTRL-V2", currentHtsCode: "8504.40.9550" }),
      ref,
    );
    expect(result.outcome).toBe("ambiguous");
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].code).toBe("8537.10.9170");
  });

  it("story map drives the four seeded review paths", async () => {
    const brake = await classifier.classify(
      input({ sku: "EB-BRK-HYD", currentHtsCode: "8714.94.3080" }),
      ref,
    );
    expect(brake.outcome).toBe("certain");
    expect(brake.candidates[0].code).toBe("8714.94.9000");

    const charger = await classifier.classify(
      input({ sku: "EB-CHG-48V", currentHtsCode: null }),
      ref,
    );
    expect(charger.outcome).toBe("certain");
    expect(charger.candidates[0].code).toBe("8504.40.9550");

    const display = await classifier.classify(
      input({ sku: "EB-DSP-LCD", currentHtsCode: "8531.20.0040" }),
      ref,
    );
    expect(display.outcome).toBe("certain");
    expect(display.candidates[0].code).toBe("8531.20.0040");
  });

  it("fallback proposes schedule siblings of the current code", async () => {
    const result = await classifier.classify(
      input({ sku: "UNKNOWN-1", currentHtsCode: "8714.99.5000" }),
      ref,
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      expect(c.codeDigits.startsWith("8714")).toBe(true);
    }
  });

  it("no code and no story yields outcome none", async () => {
    const result = await classifier.classify(
      input({ sku: "UNKNOWN-2", currentHtsCode: null }),
      ref,
    );
    expect(result.outcome).toBe("none");
    expect(result.candidates).toEqual([]);
  });
});
