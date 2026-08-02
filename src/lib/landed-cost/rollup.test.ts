import { describe, expect, it } from "vitest";

import type { ActualChargeInput } from "./actual";
import { rollupBySku, type RollupLine } from "./rollup";

let nextLine = 1;

function line(over: Partial<RollupLine>): RollupLine {
  return {
    partId: "part-1",
    sku: "SKU-A",
    entryId: "entry-1",
    entryNumber: "231-0000001-1",
    entryDate: "2026-06-10",
    lineNumber: nextLine++,
    quantity: 10,
    enteredValueCents: 10_000,
    charges: [],
    ...over,
  };
}

function duty(amountCents: number): ActualChargeInput {
  return { chargeType: "base_duty", amountCents, htsCode: null, rate: null };
}

function fee(amountCents: number): ActualChargeInput {
  return { chargeType: "mpf", amountCents, htsCode: "499", rate: null };
}

describe("rollupBySku", () => {
  it("groups by part across entries with month buckets and latest snapshot", () => {
    const rollups = rollupBySku([
      line({
        entryId: "e1",
        entryNumber: "N1",
        entryDate: "2026-06-10",
        quantity: 10,
        enteredValueCents: 10_000,
        charges: [duty(400), fee(35)],
      }),
      line({
        entryId: "e2",
        entryNumber: "N2",
        entryDate: "2026-07-01",
        quantity: 5,
        enteredValueCents: 6_000,
        charges: [duty(600)],
      }),
    ]);

    expect(rollups).toHaveLength(1);
    const r = rollups[0];
    expect(r.key).toBe("part-1");
    expect(r.quantity).toBe(15);
    expect(r.merchandiseCents).toBe(16_000);
    expect(r.dutyCents).toBe(1_000);
    expect(r.feeCents).toBe(35);
    expect(r.landedCents).toBe(17_035);
    expect(r.perUnitCents).toBe(Math.round(17_035 / 15));
    expect(r.entryCount).toBe(2);
    expect(r.lineCount).toBe(2);
    expect(r.firstEntryDate).toBe("2026-06-10");
    expect(r.lastEntryDate).toBe("2026-07-01");
    expect(r.monthly).toEqual([
      {
        month: "2026-06",
        quantity: 10,
        landedCents: 10_435,
        perUnitCents: Math.round(10_435 / 10),
      },
      {
        month: "2026-07",
        quantity: 5,
        landedCents: 6_600,
        perUnitCents: 1_320,
      },
    ]);
    expect(r.latest.entryNumber).toBe("N2");
    expect(r.latest.perUnitCents).toBe(1_320);
  });

  it("falls back to sku-string grouping and never merges linked with unlinked lines", () => {
    const rollups = rollupBySku([
      line({ partId: "part-1", sku: "SKU-A", enteredValueCents: 10_000 }),
      line({ partId: null, sku: "SKU-A", enteredValueCents: 4_000 }),
      line({ partId: null, sku: null, enteredValueCents: 99_999 }),
    ]);

    expect(rollups.map((r) => r.key).sort()).toEqual(["part-1", "sku:SKU-A"]);
    const linked = rollups.find((r) => r.key === "part-1")!;
    const unlinked = rollups.find((r) => r.key === "sku:SKU-A")!;
    expect(linked.merchandiseCents).toBe(10_000);
    expect(unlinked.merchandiseCents).toBe(4_000);
    // The partId/sku-less line is dropped from the SKU surface entirely.
    expect(rollups.reduce((s, r) => s + r.merchandiseCents, 0)).toBe(14_000);
  });

  it("weights per-unit over positive-quantity lines only and flags coverage", () => {
    const rollups = rollupBySku([
      line({ quantity: 10, enteredValueCents: 10_000, charges: [duty(500)] }),
      line({ quantity: null, enteredValueCents: 5_000, charges: [duty(250)] }),
    ]);

    const r = rollups[0];
    expect(r.qtyCoverage).toBe("partial");
    // Only the 10-unit line participates in per-unit math.
    expect(r.perUnitCents).toBe(Math.round(10_500 / 10));
    // But its money still counts in the totals.
    expect(r.landedCents).toBe(15_750);
  });

  it("full quantity coverage is reported as such", () => {
    const rollups = rollupBySku([line({ quantity: 2 })]);
    expect(rollups[0].qtyCoverage).toBe("full");
  });

  it("sorts by landed cents descending", () => {
    const rollups = rollupBySku([
      line({ partId: "small", enteredValueCents: 1_000 }),
      line({ partId: "big", enteredValueCents: 50_000 }),
    ]);
    expect(rollups.map((r) => r.key)).toEqual(["big", "small"]);
  });

  it("a dated line beats an undated one for the latest snapshot", () => {
    const rollups = rollupBySku([
      line({ entryDate: null, entryNumber: "UNDATED" }),
      line({ entryDate: "2026-01-05", entryNumber: "DATED" }),
    ]);
    expect(rollups[0].latest.entryNumber).toBe("DATED");
  });
});
