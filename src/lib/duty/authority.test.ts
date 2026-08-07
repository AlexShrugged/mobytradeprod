import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import {
  computeAuthorityBreakdown,
  effectiveDutyRate,
  resolveChargeBucket,
  type BucketableCharge,
} from "./authority";

// Fixed anchor (2026-08-11) — see calculator.test.ts; the Section 122 pair
// plays no role here, the anchor just keeps the seed build deterministic.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const ref = buildSeedReferenceData(day);
const empty = { htsByDigits: new Map(), measures: [], stackingRules: [] };

const resolve = (digits: string | null) =>
  resolveChargeBucket("additional_duty", digits, ref);
// Resolution with no reference data — exercises the legacy fallbacks alone.
const resolveBare = (digits: string) =>
  resolveChargeBucket("additional_duty", digits, empty);

describe("resolveChargeBucket: charge types", () => {
  it("maps non-additional charge types directly", () => {
    expect(resolveChargeBucket("base_duty", "8501314000", ref)).toBe("base_duty");
    expect(resolveChargeBucket("mpf", "499", ref)).toBe("mpf");
    expect(resolveChargeBucket("hmf", "501", ref)).toBe("hmf");
    expect(resolveChargeBucket("other_fee", "056", ref)).toBe("other_fee");
    expect(resolveChargeBucket("antidumping", null, ref)).toBe("antidumping");
    expect(resolveChargeBucket("countervailing", null, ref)).toBe(
      "countervailing",
    );
  });

  it("an additional duty with no code lands in other_ch99", () => {
    expect(resolve(null)).toBe("other_ch99");
  });
});

describe("resolveChargeBucket: reference data first", () => {
  it("resolves seeded Ch99 codes through the measure FK", () => {
    expect(resolve("99038801")).toBe("section_301"); // List 1
    expect(resolve("99038803")).toBe("section_301"); // List 3
    expect(resolve("99038815")).toBe("section_301"); // List 4A
    expect(resolve("99030125")).toBe("reciprocal"); // baseline
    expect(resolve("99038508")).toBe("section_232_aluminum");
  });

  it("reference data beats the legacy prefix map", () => {
    // Legacy reports bucketed 990385% as Section 301 (with 990388%); our
    // reference files 9903.85.08 under 232 aluminum. FK must win.
    expect(resolve("99038508")).toBe("section_232_aluminum");
    // And 9903.01.25 sits in legacy's 990301%->IEEPA range but is the
    // reciprocal baseline in our reference.
    expect(resolve("99030125")).toBe("reciprocal");
  });

  it("exclusion (exemption) rows still bucket under their measure", () => {
    // 9903.88.67 is the seeded List 3 exclusion. Its hts row carries the
    // measure FK even though no MeasureRef exists for it; the 990388 prefix
    // fallback still buckets it as 301.
    expect(resolve("99038867")).toBe("section_301");
  });
});

describe("resolveChargeBucket: legacy exact lists", () => {
  it("maps every legacy entries-UI code (8-digit root)", () => {
    expect(resolveBare("99038803")).toBe("section_301");
    expect(resolveBare("99038815")).toBe("section_301");
    expect(resolveBare("99030124")).toBe("ieepa");
    expect(resolveBare("99030133")).toBe("ieepa");
    expect(resolveBare("99038001")).toBe("section_232_steel");
    expect(resolveBare("99039201")).toBe("section_232_steel");
    expect(resolveBare("99038002")).toBe("section_232_aluminum");
    expect(resolveBare("99038004")).toBe("section_232_aluminum");
    expect(resolveBare("99039202")).toBe("section_232_aluminum");
    expect(resolveBare("99039701")).toBe("reciprocal");
  });

  it("matches 10-digit statistical suffixes on the 8-digit root", () => {
    expect(resolveBare("9903880300")).toBe("section_301");
    expect(resolveBare("9903920100")).toBe("section_232_steel");
    expect(resolveBare("9903970100")).toBe("reciprocal");
  });
});

describe("resolveChargeBucket: prefix fallbacks", () => {
  it("applies the legacy reports prefix buckets", () => {
    expect(resolveBare("99030110")).toBe("ieepa"); // 990301% (e.g. Canada IEEPA)
    expect(resolveBare("99030263")).toBe("reciprocal"); // 990302% country rates
    expect(resolveBare("99038811")).toBe("section_301"); // other 301 lists
    expect(resolveBare("99037812")).toBe("section_232"); // unsplit 232
    expect(resolveBare("99038095")).toBe("section_232");
    expect(resolveBare("99038134")).toBe("section_232");
    expect(resolveBare("99039280")).toBe("section_232");
  });

  it("corrects legacy's 990385->301 lumping to 232 aluminum", () => {
    expect(resolveBare("99038502")).toBe("section_232_aluminum");
  });

  it("unknown Chapter 99 codes land in other_ch99, never dropped", () => {
    expect(resolveBare("99034512")).toBe("other_ch99");
    expect(resolveBare("99990000")).toBe("other_ch99");
  });
});

describe("computeAuthorityBreakdown", () => {
  const charges: BucketableCharge[] = [
    { chargeType: "base_duty", htsCodeDigits: "8501314000", rate: "0.04", amount: "400.00" },
    { chargeType: "additional_duty", htsCodeDigits: "99038801", rate: "0.25", amount: "2500.00" },
    { chargeType: "additional_duty", htsCodeDigits: "99038815", rate: "0.075", amount: "750.00" },
    { chargeType: "additional_duty", htsCodeDigits: "99030125", rate: "0.10", amount: "1000.00" },
    { chargeType: "mpf", htsCodeDigits: "499", rate: "0.003464", amount: "34.64" },
    { chargeType: "hmf", htsCodeDigits: "501", rate: "0.00125", amount: "12.50" },
    { chargeType: "antidumping", htsCodeDigits: null, rate: null, amount: "310.00" },
  ];

  it("sums amounts and takes the max rate per bucket, in display order", () => {
    const rows = computeAuthorityBreakdown(charges, ref);
    expect(rows.map((r) => r.bucket)).toEqual([
      "base_duty",
      "section_301",
      "reciprocal",
      "antidumping",
      "mpf",
      "hmf",
    ]);
    const s301 = rows.find((r) => r.bucket === "section_301")!;
    expect(s301.amountCents).toBe(325000); // 2500 + 750
    expect(s301.maxRate).toBe(0.25); // max, not sum
    expect(s301.codes).toEqual(["99038801", "99038815"]);
    expect(s301.chargeCount).toBe(2);
    const ad = rows.find((r) => r.bucket === "antidumping")!;
    expect(ad.maxRate).toBeNull();
  });

  it("every input charge lands in exactly one bucket (sum reconciles)", () => {
    const rows = computeAuthorityBreakdown(charges, ref);
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    const input = charges.reduce(
      (s, c) => s + Math.round(Number(c.amount) * 100),
      0,
    );
    expect(total).toBe(input);
    expect(rows.reduce((s, r) => s + r.chargeCount, 0)).toBe(charges.length);
  });

  it("returns an empty list for no charges", () => {
    expect(computeAuthorityBreakdown([], ref)).toEqual([]);
  });
});

describe("effectiveDutyRate", () => {
  it("divides total duty by entered value", () => {
    expect(effectiveDutyRate(390000, 1000000)).toBeCloseTo(0.39);
  });
  it("is null on zero or unknown denominators and unknown duty", () => {
    expect(effectiveDutyRate(390000, 0)).toBeNull();
    expect(effectiveDutyRate(390000, null)).toBeNull();
    expect(effectiveDutyRate(null, 1000000)).toBeNull();
  });
});

describe("resolveChargeBucket: entry-date measure windows", () => {
  // One Ch99 digits string backed by two tiled measure windows under
  // DIFFERENT authorities — the bucket must follow the window active on
  // the entry date, not blindly take the latest row.
  const mkMeasure = (
    id: string,
    authority: "section_301" | "ieepa",
    effectiveDate: string,
    endDate: string | null,
  ) => ({
    id,
    name: `measure ${id}`,
    authority,
    scope: "hts_list" as const,
    countries: null,
    effectiveDate,
    endDate,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    inLieuOfBaseDuty: false,
    ch99Code: "9903.99.99",
    ch99Digits: "99039999",
    rate: 0.1,
    exclusionDigits: [],
    prefixes: [],
  });
  const windowedRef = {
    htsByDigits: new Map([
      [
        "99039999",
        {
          code: "9903.99.99",
          codeDigits: "99039999",
          description: "windowed measure line",
          chapter: 99,
          rateType: "ad_valorem" as const,
          rate: 0.1,
          exemption: false,
          tradeMeasureId: "m2", // latest window backs the flat map
        },
      ],
    ]),
    measures: [
      mkMeasure("m1", "section_301", "2026-01-01", "2026-05-31"),
      mkMeasure("m2", "ieepa", "2026-06-01", null),
    ],
    stackingRules: [],
  };

  it("buckets by the measure window active on the entry date", () => {
    expect(
      resolveChargeBucket("additional_duty", "99039999", windowedRef, "2026-03-15"),
    ).toBe("section_301");
    expect(
      resolveChargeBucket("additional_duty", "99039999", windowedRef, "2026-07-01"),
    ).toBe("ieepa");
  });

  it("falls back to the latest-window row without an entry date", () => {
    expect(resolveChargeBucket("additional_duty", "99039999", windowedRef)).toBe(
      "ieepa",
    );
  });

  it("threads the entry date through the breakdown rollup", () => {
    const charges: BucketableCharge[] = [
      {
        chargeType: "additional_duty",
        htsCodeDigits: "99039999",
        rate: "0.10",
        amount: "1000.00",
      },
    ];
    const early = computeAuthorityBreakdown(charges, windowedRef, "2026-03-15");
    expect(early.map((b) => b.bucket)).toEqual(["section_301"]);
    const late = computeAuthorityBreakdown(charges, windowedRef, "2026-07-01");
    expect(late.map((b) => b.bucket)).toEqual(["ieepa"]);
  });
});
