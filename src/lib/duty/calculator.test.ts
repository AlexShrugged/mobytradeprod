import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import {
  applyStacking,
  computeExpectedCharges,
  normalizeHts,
  resolveBaseSchedule,
  resolveExpectedMeasures,
} from "./calculator";
import type {
  HtsRef,
  MeasureRef,
  ReferenceData,
  StackingRuleRef,
} from "./types";

// Fixed anchor (2026-08-11) so the seed's day-relative Section 122 pair
// lands on mobynew's canonical timeline: cutoff day(-10) = 2026-08-01,
// last pre-cutoff sail day(-11) = 2026-07-31. Tests stay deterministic on
// any run date.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const ref = buildSeedReferenceData(day);

const ENTRY_DATE = "2026-06-10";

function line(htsCode: string, coo: string | null, valueCents = 10_000_000) {
  return {
    htsDigits: normalizeHts(htsCode),
    countryOfOrigin: coo,
    enteredValueCents: valueCents,
    entryDate: ENTRY_DATE,
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

describe("normalizeHts", () => {
  it("strips everything but digits", () => {
    expect(normalizeHts("9903.88.01")).toBe("99038801");
    expect(normalizeHts("8501.31.4000")).toBe("8501314000");
    expect(normalizeHts("499")).toBe("499");
  });
});

describe("computeExpectedCharges over seed reference data", () => {
  it("CN motor gets base 4% + 301 List 1 + reciprocal, nothing suppressed", () => {
    const result = computeExpectedCharges(line("8501.31.4000", "CN"), ref);

    expect(result.baseDuty).toEqual({
      rate: 0.04,
      amountCents: 400_000,
      rateType: "ad_valorem",
    });
    expect(result.measures.map((m) => m.ch99Code).sort()).toEqual([
      "9903.01.25",
      "9903.88.01",
    ]);
    const l1 = result.measures.find((m) => m.ch99Code === "9903.88.01")!;
    expect(l1.rate).toBe(0.25);
    expect(l1.amountCents).toBe(2_500_000);
    expect(result.suppressed).toEqual([]);
    expect(result.baseDutyZeroedBy).toBeNull();
  });

  it("TW aluminum frame gets 232, reciprocal suppressed with the rule reason, no 301", () => {
    const result = computeExpectedCharges(line("8714.91.3000", "TW"), ref);

    expect(result.baseDuty?.rate).toBe(0.039);
    expect(result.measures.map((m) => m.authority)).toEqual([
      "section_232_aluminum",
    ]);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].authority).toBe("reciprocal");
    expect(result.suppressed[0].suppressedBy.winnerAuthority).toBe(
      "section_232_aluminum",
    );
    expect(result.suppressed[0].suppressedBy.reason).toContain("E.O. 14257");
  });

  it("VN tire gets only the reciprocal baseline over a free base rate", () => {
    const result = computeExpectedCharges(line("4011.50.0000", "VN"), ref);

    expect(result.baseDuty).toEqual({
      rate: 0,
      amountCents: 0,
      rateType: "free",
    });
    expect(result.measures.map((m) => m.authority)).toEqual(["reciprocal"]);
    expect(result.measures[0].amountCents).toBe(1_000_000);
  });

  it("CN brake pads land on 301 List 4A at 7.5%", () => {
    const result = computeExpectedCharges(line("8714.94.9000", "CN"), ref);

    expect(result.measures.map((m) => m.ch99Code).sort()).toEqual([
      "9903.01.25",
      "9903.88.15",
    ]);
    const l4a = result.measures.find((m) => m.ch99Code === "9903.88.15")!;
    expect(l4a.rate).toBe(0.075);
    expect(l4a.amountCents).toBe(750_000);
  });

  it("date gates: before the reciprocal effective date only 301 applies", () => {
    const result = computeExpectedCharges(
      { ...line("8501.31.4000", "CN"), entryDate: "2024-01-01" },
      ref,
    );
    expect(result.measures.map((m) => m.authority)).toEqual(["section_301"]);
  });

  it("unknown HTS yields null base duty but country-wide measures still apply", () => {
    const result = computeExpectedCharges(line("0101.21.0010", "CN"), ref);
    expect(result.baseDuty).toBeNull();
    expect(result.measures.map((m) => m.authority)).toEqual(["reciprocal"]);
  });

  it("List 3 measures carry their exclusion digits", () => {
    const { applicable } = resolveExpectedMeasures(
      line("8507.60.0020", "CN"),
      ref,
    );
    const l3 = applicable.find((m) => m.ch99Code === "9903.88.03")!;
    expect(l3.exclusionDigits).toEqual(["99038867"]);
  });

  it("rounds expected amounts to whole cents", () => {
    // 3.9% of $333.33 = $13.0000 - odd values must round, not truncate.
    const result = computeExpectedCharges(
      line("8714.91.3000", "TW", 33_333),
      ref,
    );
    expect(result.baseDuty?.amountCents).toBe(Math.round(0.039 * 33_333));
  });
});

describe("entry-date-aware base-rate windows", () => {
  // Two change-tiling windows for the CN motor code: 4% through 2026-06-30
  // (closed), 6% from 2026-07-01 (current). htsByDigits carries the CURRENT
  // row, mirroring loadReferenceData.
  const motor = ref.htsByDigits.get("8501314000")!;
  const digits = "8501314000";
  const oldWindow: HtsRef = {
    ...motor,
    rate: 0.04,
    validFrom: "2025-01-01",
    validTo: "2026-06-30",
  };
  const newWindow: HtsRef = {
    ...motor,
    rate: 0.06,
    validFrom: "2026-07-01",
    validTo: null,
  };
  const windowed: ReferenceData = {
    htsByDigits: new Map(ref.htsByDigits).set(digits, newWindow),
    baseWindowsByDigits: new Map([[digits, [newWindow, oldWindow]]]),
    measures: [],
    stackingRules: [],
  };

  it("an entry inside the closed window uses that window's rate", () => {
    const result = computeExpectedCharges(
      {
        htsDigits: digits,
        countryOfOrigin: "CN",
        enteredValueCents: 1_000_000,
        entryDate: "2026-06-10",
      },
      windowed,
    );
    expect(result.baseDuty).toEqual({
      rate: 0.04,
      amountCents: 40_000,
      rateType: "ad_valorem",
    });
  });

  it("an entry inside the current window uses the successor's rate", () => {
    const result = computeExpectedCharges(
      {
        htsDigits: digits,
        countryOfOrigin: "CN",
        enteredValueCents: 1_000_000,
        entryDate: "2026-07-15",
      },
      windowed,
    );
    expect(result.baseDuty).toEqual({
      rate: 0.06,
      amountCents: 60_000,
      rateType: "ad_valorem",
    });
  });

  it("window boundaries are inclusive on both ends", () => {
    expect(resolveBaseSchedule(digits, "2026-06-30", windowed)?.rate).toBe(0.04);
    expect(resolveBaseSchedule(digits, "2026-07-01", windowed)?.rate).toBe(0.06);
  });

  it("an entry before every window falls back to the current row", () => {
    expect(resolveBaseSchedule(digits, "2024-01-01", windowed)?.rate).toBe(0.06);
  });

  it("no windows map (in-memory refs) preserves current-row behavior", () => {
    // The seed builder carries no windows: resolution must be byte-identical
    // to a plain htsByDigits lookup on any date.
    expect(resolveBaseSchedule(digits, "2020-01-01", ref)).toBe(
      ref.htsByDigits.get(digits),
    );
    expect(resolveBaseSchedule(digits, ENTRY_DATE, ref)).toBe(
      ref.htsByDigits.get(digits),
    );
  });
});

describe("in-lieu-of base duty", () => {
  it("zeroes the base amount but keeps the rate, and reports the authority", () => {
    const inLieu = measure({
      authority: "section_232_aluminum",
      inLieuOfBaseDuty: true,
      prefixes: ["8501"],
      rate: 0.25,
    });
    const synthetic: ReferenceData = {
      htsByDigits: ref.htsByDigits,
      measures: [inLieu],
      stackingRules: [],
    };
    const result = computeExpectedCharges(line("8501.31.4000", "CN"), synthetic);

    expect(result.baseDuty).toEqual({
      rate: 0.04,
      amountCents: 0,
      rateType: "ad_valorem",
    });
    expect(result.baseDutyZeroedBy).toBe("section_232_aluminum");
  });
});

describe("exclusionPrefixes carve-outs", () => {
  it("removes the measure before stacking, so its suppression never fires", () => {
    const alu = measure({
      id: "alu",
      authority: "section_232_aluminum",
      prefixes: ["8714"],
      exclusionPrefixes: ["871491"],
    });
    const rec = measure({
      id: "rec",
      authority: "reciprocal",
      scope: "all_products",
      prefixes: [],
      // Distinct Chapter 99 identity — same-code siblings get deduped.
      ch99Code: "9903.01.25",
      ch99Digits: "99030125",
    });
    const synthetic: ReferenceData = {
      htsByDigits: ref.htsByDigits,
      measures: [alu, rec],
      stackingRules: [
        {
          winnerAuthority: "section_232_aluminum",
          loserAuthority: "reciprocal",
          reason: "test",
          effectiveDate: "2020-01-01",
          endDate: null,
        },
      ],
    };

    // Carved-out line: 232 never applies, so the reciprocal survives.
    const excluded = resolveExpectedMeasures(line("8714.91.3000", "TW"), synthetic);
    expect(excluded.applicable.map((m) => m.id)).toEqual(["rec"]);
    expect(excluded.suppressed).toEqual([]);

    // Covered line: 232 applies and suppresses the reciprocal.
    const covered = resolveExpectedMeasures(line("8714.92.1000", "TW"), synthetic);
    expect(covered.applicable.map((m) => m.id)).toEqual(["alu"]);
    expect(covered.suppressed.map((m) => m.id)).toEqual(["rec"]);
  });

  it("absent exclusionPrefixes leaves seed-matrix behavior untouched", () => {
    // Spot-check the canonical seed cases still produce their known stacks.
    const motor = computeExpectedCharges(line("8501.31.4000", "CN"), ref);
    expect(motor.measures.map((m) => m.ch99Code).sort()).toEqual([
      "9903.01.25",
      "9903.88.01",
    ]);
    const frame = computeExpectedCharges(line("8714.91.3000", "TW"), ref);
    expect(frame.suppressed.map((m) => m.authority)).toEqual(["reciprocal"]);
  });
});

describe("applyStacking", () => {
  const rules: StackingRuleRef[] = [
    {
      winnerAuthority: "section_232_aluminum",
      loserAuthority: "reciprocal",
      reason: "aluminum beats reciprocal",
      effectiveDate: "2025-04-05",
      endDate: null,
    },
    {
      winnerAuthority: "reciprocal",
      loserAuthority: "section_301",
      reason: "reciprocal beats 301 (synthetic)",
      effectiveDate: "2025-04-05",
      endDate: null,
    },
  ];

  it("a suppressed loser cannot win a later rule", () => {
    const candidates = [
      measure({ id: "alu", authority: "section_232_aluminum" }),
      measure({ id: "rec", authority: "reciprocal" }),
      measure({ id: "s301", authority: "section_301" }),
    ];
    const { applicable, suppressed } = applyStacking(
      candidates,
      rules,
      ENTRY_DATE,
    );

    // Rule 1 removes reciprocal; rule 2's winner is gone, so 301 survives.
    expect(applicable.map((m) => m.id).sort()).toEqual(["alu", "s301"]);
    expect(suppressed.map((m) => m.id)).toEqual(["rec"]);
  });

  it("rules outside their effective window do not fire", () => {
    const candidates = [
      measure({ id: "alu", authority: "section_232_aluminum" }),
      measure({ id: "rec", authority: "reciprocal" }),
    ];
    const { applicable } = applyStacking(candidates, rules, "2025-01-01");
    expect(applicable).toHaveLength(2);
  });

  it("does nothing when the winner is absent", () => {
    const candidates = [measure({ id: "rec", authority: "reciprocal" })];
    const { applicable, suppressed } = applyStacking(
      candidates,
      [rules[0]],
      ENTRY_DATE,
    );
    expect(applicable.map((m) => m.id)).toEqual(["rec"]);
    expect(suppressed).toEqual([]);
  });
});

describe("countriesExcluded carve-outs", () => {
  const excluding = measure({
    scope: "all_products",
    prefixes: [],
    countries: null,
    countriesExcluded: ["CA", "MX"],
  });
  const synthetic: ReferenceData = {
    htsByDigits: ref.htsByDigits,
    measures: [excluding],
    stackingRules: [],
  };

  it("drops the measure for an excluded country of origin", () => {
    const result = resolveExpectedMeasures(line("8501.31.4000", "CA"), synthetic);
    expect(result.applicable).toEqual([]);
  });

  it("keeps the measure for a non-excluded country", () => {
    const result = resolveExpectedMeasures(line("8501.31.4000", "CN"), synthetic);
    expect(result.applicable.map((m) => m.id)).toEqual(["m"]);
  });

  it("an unknown COO is NOT excluded — expectations bias toward duty owed", () => {
    const result = resolveExpectedMeasures(line("8501.31.4000", null), synthetic);
    expect(result.applicable.map((m) => m.id)).toEqual(["m"]);
  });
});

describe("non-ad-valorem (presence-only) measures", () => {
  it("stays expected with a null amount — never computed, never dropped", () => {
    const specific = measure({
      rate: null,
      rateType: "specific",
      rateText: "$80/net ton",
      prefixes: ["8501"],
    });
    const synthetic: ReferenceData = {
      htsByDigits: ref.htsByDigits,
      measures: [specific],
      stackingRules: [],
    };
    const result = computeExpectedCharges(line("8501.31.4000", "CN"), synthetic);
    expect(result.measures).toHaveLength(1);
    expect(result.measures[0].amountCents).toBeNull();
    expect(result.measures[0].rateText).toBe("$80/net ton");
  });
});
