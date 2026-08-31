import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import {
  computeAlertImpact,
  computeCatalogExpected,
  expectedTotalCents,
  type ImpactContext,
  type ImpactLineSnapshot,
} from "./impact";

// Fixed anchor (2026-08-11), same as rules.test.ts — entry dates here
// predate the Section 122 cutoff so the surcharge never enters these
// expectations.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const ref = buildSeedReferenceData(day);

const ctx = (over: Partial<ImpactContext> = {}): ImpactContext => ({
  ref,
  entryDate: "2026-06-10",
  sail: null,
  entryTrusted: true,
  ...over,
});

// The seeded brake plant: TW origin, $16,200 entered, declared under the
// dutiable 8714.94.9000 (10%) while the catalog says 8714.94.3080 (free).
// TW dodges Section 301; 871494 dodges Section 232; reciprocal 10% applies
// under either code.
const brakeLine = (
  over: Partial<ImpactLineSnapshot> = {},
): ImpactLineSnapshot => ({
  htsCodeDigits: "8714949000",
  countryOfOrigin: "TW",
  enteredValueCents: 16_200_00,
  catalogHtsDigits: "8714943080",
  catalogHtsDigitsCurrent: "8714943080",
  declaredDutyCents: 3_240_00, // 10% base + 10% reciprocal, as filed
  ...over,
});

const alert = (alertType: string, details: Record<string, unknown> | null) => ({
  alertType,
  details,
});

describe("amount_mismatch", () => {
  it("overpaid declares recoverable, underpaid declares exposure", () => {
    expect(
      computeAlertImpact(
        alert("amount_mismatch", { expected_amount: 1000, actual_amount: 1250 }),
        null,
        ctx(),
      ),
    ).toEqual({ impactCents: 250_00, direction: "recoverable" });
    expect(
      computeAlertImpact(
        alert("amount_mismatch", { expected_amount: 1250, actual_amount: 1000 }),
        null,
        ctx(),
      ),
    ).toEqual({ impactCents: -250_00, direction: "exposure" });
  });

  it("returns no impact without both amounts", () => {
    expect(
      computeAlertImpact(
        alert("amount_mismatch", { actual_amount: 1000 }),
        null,
        ctx(),
      ).impactCents,
    ).toBeNull();
  });
});

describe("rate_mismatch", () => {
  it("recomputes the implied delta from the line's entered value", () => {
    // The seeded planted finding: 301 List 1 declared at 20% vs official
    // 25% on $34,740 entered — a $1,737 underpayment.
    const line = brakeLine({ enteredValueCents: 34_740_00 });
    expect(
      computeAlertImpact(
        alert("rate_mismatch", { expected_rate: 0.25, actual_rate: 0.2 }),
        line,
        ctx(),
      ),
    ).toEqual({ impactCents: -1_737_00, direction: "exposure" });
  });

  it("returns no impact without the line", () => {
    expect(
      computeAlertImpact(
        alert("rate_mismatch", { expected_rate: 0.25, actual_rate: 0.2 }),
        null,
        ctx(),
      ).impactCents,
    ).toBeNull();
  });
});

describe("missing_measure", () => {
  it("is pure exposure for the expected amount", () => {
    expect(
      computeAlertImpact(
        alert("missing_measure", { expected_amount: 7800 }),
        null,
        ctx(),
      ),
    ).toEqual({ impactCents: -7_800_00, direction: "exposure" });
  });
});

describe("unexpected_measure", () => {
  it("claims the charge only when stacking suppressed it", () => {
    expect(
      computeAlertImpact(
        alert("unexpected_measure", {
          actual_amount: 500,
          stacking_reason: "Aluminum articles are exempt from reciprocal.",
        }),
        null,
        ctx(),
      ),
    ).toEqual({ impactCents: 500_00, direction: "recoverable" });
  });

  it("claims nothing on a possible coverage gap", () => {
    expect(
      computeAlertImpact(
        alert("unexpected_measure", { actual_amount: 500 }),
        null,
        ctx(),
      ).impactCents,
    ).toBeNull();
  });
});

describe("hts_discrepancy", () => {
  it("computes declared duty minus expected-under-catalog", () => {
    // Declared $3,240 vs catalog-free base + 10% reciprocal = $1,620.
    expect(
      computeAlertImpact(alert("hts_discrepancy", {}), brakeLine(), ctx()),
    ).toEqual({ impactCents: 1_620_00, direction: "recoverable" });
  });

  it("returns no impact when the entry's charge data is untrusted", () => {
    expect(
      computeAlertImpact(
        alert("hts_discrepancy", {}),
        brakeLine(),
        ctx({ entryTrusted: false }),
      ).impactCents,
    ).toBeNull();
  });

  it("returns no impact when the line has no ingested charges", () => {
    expect(
      computeAlertImpact(
        alert("hts_discrepancy", {}),
        brakeLine({ declaredDutyCents: null }),
        ctx(),
      ).impactCents,
    ).toBeNull();
  });

  it("returns no impact without a committed catalog code", () => {
    expect(
      computeAlertImpact(
        alert("hts_discrepancy", {}),
        brakeLine({ catalogHtsDigits: null }),
        ctx(),
      ).impactCents,
    ).toBeNull();
  });

  it("returns no impact when the catalog code is not in reference data", () => {
    expect(
      computeAlertImpact(
        alert("hts_discrepancy", {}),
        brakeLine({ catalogHtsDigits: "9999999999" }),
        ctx(),
      ).impactCents,
    ).toBeNull();
  });

  it("returns no impact without an entry date", () => {
    expect(
      computeAlertImpact(
        alert("hts_discrepancy", {}),
        brakeLine(),
        ctx({ entryDate: null }),
      ).impactCents,
    ).toBeNull();
  });
});

describe("computeCatalogExpected / expectedTotalCents", () => {
  it("builds the catalog counterfactual stack", () => {
    const expected = computeCatalogExpected(brakeLine(), ctx());
    expect(expected).not.toBeNull();
    expect(expected!.baseDuty?.amountCents).toBe(0); // 8714.94.3080 is free
    expect(expected!.measures.map((m) => m.ch99Digits)).toEqual(["99030125"]);
    expect(expectedTotalCents(expected!)).toBe(1_620_00);
  });

  it("totals to null for non-computable base duty", () => {
    expect(
      expectedTotalCents({
        baseDuty: null,
        measures: [],
        suppressed: [],
        baseDutyZeroedBy: null,
        baseDutyClaim: null,
        sailBasis: null,
      }),
    ).toBeNull();
    expect(
      expectedTotalCents({
        baseDuty: { rate: null, amountCents: null, rateType: "specific" },
        measures: [],
        suppressed: [],
        baseDutyZeroedBy: null,
        baseDutyClaim: null,
        sailBasis: null,
      }),
    ).toBeNull();
  });
});

describe("informational types", () => {
  it.each([
    "coo_discrepancy",
    "data_unreconciled",
    "sail_date_assumption",
    "quantity_discrepancy",
    "invoice_sku_missing",
    "invoice_comparison_skipped",
    "invoice_hts_mismatch",
  ])("%s carries no dollar claim", (type) => {
    expect(
      computeAlertImpact(alert(type, { expected_amount: 100 }), null, ctx())
        .impactCents,
    ).toBeNull();
  });
});

describe("value_mismatch (CI value variance)", () => {
  // The seeded INV-2026-198 plant: entry declares $10,976 against a
  // $10,476 CI at a 10% effective duty rate — $500 over-declared value,
  // $50 of duty overpaid.
  const details = {
    expected_amount: 10476, // the CI
    actual_amount: 10976, // the filed entry
    effective_duty_rate: 0.1,
  };

  it("over-declared value is recoverable duty: delta × effective rate", () => {
    expect(
      computeAlertImpact(alert("value_mismatch", details), null, ctx()),
    ).toEqual({ impactCents: 50_00, direction: "recoverable" });
  });

  it("under-declared value is exposure", () => {
    expect(
      computeAlertImpact(
        alert("value_mismatch", {
          ...details,
          expected_amount: 10976,
          actual_amount: 10476,
        }),
        null,
        ctx(),
      ),
    ).toEqual({ impactCents: -50_00, direction: "exposure" });
  });

  it("no rate in details (rules 6/8 shape) carries no claim", () => {
    expect(
      computeAlertImpact(
        alert("value_mismatch", {
          expected_amount: 10476,
          actual_amount: 10976,
        }),
        null,
        ctx(),
      ).impactCents,
    ).toBeNull();
  });

  it("returns no impact when the entry's charge data is untrusted", () => {
    expect(
      computeAlertImpact(
        alert("value_mismatch", details),
        null,
        ctx({ entryTrusted: false }),
      ).impactCents,
    ).toBeNull();
  });
});

describe("hts_reclassified", () => {
  // The seeded display storyline: filed under 8531.80.9051 (1.3%), the
  // catalog code of its day; the part now classifies 8531.20.0040 (Free).
  // TW dodges Section 301; reciprocal 10% applies under either code, so
  // the recoverable delta is exactly the base duty.
  const displayLine = (
    over: Partial<ImpactLineSnapshot> = {},
  ): ImpactLineSnapshot => ({
    htsCodeDigits: "8531809051",
    countryOfOrigin: "TW",
    enteredValueCents: 5_780_00,
    catalogHtsDigits: "8531809051", // as-of code — matched the declaration
    catalogHtsDigitsCurrent: "8531200040",
    declaredDutyCents: 653_14, // 1.3% base + 10% reciprocal, as filed
    ...over,
  });

  it("recovers the duty delta under today's classification at entry-date rules", () => {
    expect(
      computeAlertImpact(alert("hts_reclassified", {}), displayLine(), ctx()),
    ).toEqual({ impactCents: 75_14, direction: "recoverable" });
  });

  it("returns no impact without a current catalog code", () => {
    expect(
      computeAlertImpact(
        alert("hts_reclassified", {}),
        displayLine({ catalogHtsDigitsCurrent: null }),
        ctx(),
      ).impactCents,
    ).toBeNull();
  });

  it("returns no impact when the entry's charges are untrusted", () => {
    expect(
      computeAlertImpact(
        alert("hts_reclassified", {}),
        displayLine(),
        ctx({ entryTrusted: false }),
      ).impactCents,
    ).toBeNull();
  });

  it("returns no impact without declared duty or without a line", () => {
    expect(
      computeAlertImpact(
        alert("hts_reclassified", {}),
        displayLine({ declaredDutyCents: null }),
        ctx(),
      ).impactCents,
    ).toBeNull();
    expect(
      computeAlertImpact(alert("hts_reclassified", {}), null, ctx()).impactCents,
    ).toBeNull();
  });
});
