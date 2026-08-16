import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import {
  candidateDutySavingRate,
  totalExpectedDutyCents,
} from "./candidate-delta";
import { computeExpectedCharges } from "./calculator";
import type { HtsRef, MeasureRef, ReferenceData } from "./types";

// Same fixed anchor as calculator.test.ts so the seed's day-relative
// Section 122 pair stays out of the way of these dates.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const seedRef = buildSeedReferenceData(day);

const AS_OF = "2026-06-10";

const savingRate = (
  candidateDigits: string,
  currentDigits: string | null,
  origins: (string | null)[],
  ref: ReferenceData = seedRef,
) => candidateDutySavingRate({ candidateDigits, currentDigits, origins, asOf: AS_OF }, ref);

// --- synthetic reference for the fine-grained cases -----------------------

function htsRow(
  codeDigits: string,
  rate: number | null,
  rateType: HtsRef["rateType"] = "ad_valorem",
): HtsRef {
  return {
    code: codeDigits,
    codeDigits,
    description: "",
    chapter: Number(codeDigits.slice(0, 2)),
    rateType,
    rate,
    exemption: false,
    tradeMeasureId: null,
  };
}

function measure(over: Partial<MeasureRef>): MeasureRef {
  return {
    id: "m",
    name: "Test measure",
    authority: "section_301",
    scope: "hts_list",
    countries: null,
    effectiveDate: "2020-01-01",
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    inLieuOfBaseDuty: false,
    ch99Code: "9903.00.01",
    ch99Digits: "99030001",
    rate: 0.1,
    exclusionDigits: [],
    prefixes: ["8501"],
    ...over,
  };
}

function synthetic(rows: HtsRef[], measures: MeasureRef[] = []): ReferenceData {
  return {
    htsByDigits: new Map(rows.map((r) => [r.codeDigits, r])),
    measures,
    stackingRules: [],
  };
}

describe("totalExpectedDutyCents", () => {
  it("mirrors compare_codes: base + computable measures, counting nulls", () => {
    const ref = synthetic(
      [htsRow("8501314000", 0.04)],
      [
        measure({ id: "a", rate: 0.25, ch99Digits: "99038801" }),
        measure({ id: "b", rate: null, ch99Code: "9903.00.02", ch99Digits: "99030002" }),
      ],
    );
    const total = totalExpectedDutyCents(
      computeExpectedCharges(
        {
          htsDigits: "8501314000",
          countryOfOrigin: "CN",
          enteredValueCents: 1_000_000,
          entryDate: AS_OF,
          sail: null,
        },
        ref,
      ),
    );
    expect(total.totalCents).toBe(40_000 + 250_000);
    expect(total.nonComputable).toBe(1);
  });

  it("null total for a code missing from the schedule", () => {
    const total = totalExpectedDutyCents(
      computeExpectedCharges(
        {
          htsDigits: "9999999999",
          countryOfOrigin: "CN",
          enteredValueCents: 1_000_000,
          entryDate: AS_OF,
          sail: null,
        },
        synthetic([]),
      ),
    );
    expect(total).toEqual({ totalCents: null, nonComputable: 0 });
  });
});

describe("candidateDutySavingRate over seed reference data", () => {
  it("free candidate beats a 10% current under one COO", () => {
    // TW brakes: both codes carry only the reciprocal 10%; base 0% vs 10%.
    expect(savingRate("8714943080", "8714949000", ["TW"])).toBeCloseTo(0.1, 10);
  });

  it("null when the candidate is dearer", () => {
    expect(savingRate("8714949000", "8714943080", ["TW"])).toBeNull();
  });

  it("null on equal totals (strictly lower required)", () => {
    // Both 10% base, same measures.
    expect(savingRate("8714991000", "8714949000", ["TW"])).toBeNull();
  });

  it("multi-COO conflict suppresses; the winning COO alone tags", () => {
    // Current CN motor: 4% + 301 List 1 25% + reciprocal 10% = 39%;
    // VN: 14%. Candidate brake parts CN: 10% + 301 4A 7.5% + 10% = 27.5%;
    // VN: 20%. Wins under CN, loses under VN.
    expect(savingRate("8714949000", "8501314000", ["CN", "VN"])).toBeNull();
    expect(savingRate("8714949000", "8501314000", ["CN"])).toBeCloseTo(
      0.115,
      10,
    );
  });

  it("wins under every COO: returns the minimum saving", () => {
    // Candidate tire (free base): CN 0 + 7.5% + 10% = 17.5% (saves 21.5);
    // VN 10% (saves 4). Guaranteed saving is the VN 4 points.
    expect(savingRate("4011500000", "8501314000", ["CN", "VN"])).toBeCloseTo(
      0.04,
      10,
    );
  });

  it("duplicate origins collapse", () => {
    expect(savingRate("8714943080", "8714949000", ["TW", "TW"])).toBeCloseTo(
      0.1,
      10,
    );
  });
});

describe("candidateDutySavingRate guards", () => {
  it("null without a current code, on the same code, or without origins", () => {
    expect(savingRate("8714943080", null, ["TW"])).toBeNull();
    expect(savingRate("8714949000", "8714949000", ["TW"])).toBeNull();
    expect(savingRate("8714943080", "8714949000", [])).toBeNull();
  });

  it("null when any origin is unknown", () => {
    // A null COO drops country-gated measures, which could fake a saving.
    expect(savingRate("8714943080", "8714949000", ["TW", null])).toBeNull();
  });

  it("null when either code is missing from the schedule", () => {
    expect(savingRate("9999999999", "8714949000", ["TW"])).toBeNull();
    expect(savingRate("8714943080", "9999999999", ["TW"])).toBeNull();
  });

  it("null when the candidate side has a non-computable measure", () => {
    // Candidate is nominally free but a specific-rate measure covers it —
    // the hidden charge could erase the saving.
    const ref = synthetic(
      [htsRow("8501100000", 0.1), htsRow("8501200000", 0)],
      [
        measure({
          rate: null,
          rateType: "specific",
          rateText: "$0.50/kg",
          prefixes: ["85012"],
        }),
      ],
    );
    expect(savingRate("8501200000", "8501100000", ["CN"], ref)).toBeNull();
  });

  it("null when the candidate's base duty is specific-rate", () => {
    const ref = synthetic([
      htsRow("8501100000", 0.1),
      htsRow("8501200000", null, "specific"),
    ]);
    expect(savingRate("8501200000", "8501100000", ["CN"], ref)).toBeNull();
  });

  it("tolerates non-computable components on the current side", () => {
    // The unpriced measure can only understate the current total, so a
    // strictly cheaper candidate still tags.
    const ref = synthetic(
      [htsRow("8501100000", 0.1), htsRow("8501200000", 0)],
      [
        measure({
          rate: null,
          rateType: "specific",
          rateText: "$0.50/kg",
          prefixes: ["85011"],
        }),
      ],
    );
    expect(savingRate("8501200000", "8501100000", ["CN"], ref)).toBeCloseTo(
      0.1,
      10,
    );
  });

  it("prices in-lieu measures through the zeroed base", () => {
    // Candidate: base 20% zeroed by a 5% in-lieu measure → total 5%,
    // beating the 10% current.
    const ref = synthetic(
      [htsRow("8501100000", 0.1), htsRow("8501200000", 0.2)],
      [
        measure({
          rate: 0.05,
          inLieuOfBaseDuty: true,
          prefixes: ["85012"],
        }),
      ],
    );
    expect(savingRate("8501200000", "8501100000", ["CN"], ref)).toBeCloseTo(
      0.05,
      10,
    );
  });
});
