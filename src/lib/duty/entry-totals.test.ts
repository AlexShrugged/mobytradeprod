import { describe, expect, it } from "vitest";

import { deriveEntryMoney, sumEntryCharges } from "./entry-totals";

describe("sumEntryCharges", () => {
  it("buckets drizzle numeric strings by header class", () => {
    expect(
      sumEntryCharges([
        { chargeType: "base_duty", amount: "377.62" },
        { chargeType: "additional_duty", amount: "2860.75" },
        { chargeType: "additional_duty", amount: 1430.38 },
        { chargeType: "mpf", amount: "39.64" },
        { chargeType: "hmf", amount: "14.30" },
        { chargeType: "other_fee", amount: "8.54" },
        { chargeType: "antidumping", amount: "100.10" },
        { chargeType: "countervailing", amount: "0.90" },
      ]),
    ).toEqual({ dutyCents: 466_875, adcvdCents: 10_100, otherFeeCents: 854 });
  });
});

describe("deriveEntryMoney", () => {
  // ASC 231-7396836-0 (2026-10-06): one line, a $8.54 cotton fee (056).
  const cotton = {
    totalDutyCents: 466_875,
    totalBaseDutyCents: 37_762,
    mpfCents: 3_964,
    hmfCents: 1_430,
  };

  it("adds the other fees the header has no slot for", () => {
    const money = deriveEntryMoney(cotton, {
      dutyCents: 466_875,
      adcvdCents: 0,
      otherFeeCents: 854,
    });
    expect(money.dutiesAndFeesCents).toBe(473_123);
    expect(money.otherFeesCents).toBe(854);
    expect(money.additionalDutiesCents).toBe(429_113);
    expect(money.adcvdDepositsCents).toBe(0);
    expect(money.adcvdFoldedIntoDuty).toBe(false);
  });

  it("reduces to duty + MPF + HMF when the lines carry nothing else", () => {
    const money = deriveEntryMoney(cotton, {
      dutyCents: 466_875,
      adcvdCents: 0,
      otherFeeCents: 0,
    });
    expect(money.dutiesAndFeesCents).toBe(472_269);
  });

  // ASC 231-7362042-5: block 37 duty $24,533.00, Block 43 012 row $8,346.12.
  it("adds AD/CVD deposits block 37 leaves to block 39", () => {
    const money = deriveEntryMoney(
      {
        totalDutyCents: 2_453_300,
        totalBaseDutyCents: 500_000,
        mpfCents: 65_086,
        hmfCents: 12_000,
      },
      { dutyCents: 2_453_300, adcvdCents: 834_612, otherFeeCents: 0 },
    );
    expect(money.adcvdFoldedIntoDuty).toBe(false);
    expect(money.adcvdDepositsCents).toBe(834_612);
    expect(money.additionalDutiesCents).toBe(1_953_300);
    expect(money.dutiesAndFeesCents).toBe(
      2_453_300 + 834_612 + 65_086 + 12_000,
    );
  });

  it("never double counts deposits a printout folded into the duty total", () => {
    const money = deriveEntryMoney(
      {
        totalDutyCents: 2_453_300 + 834_612,
        totalBaseDutyCents: 500_000,
        mpfCents: 65_086,
        hmfCents: 12_000,
      },
      { dutyCents: 2_453_300, adcvdCents: 834_612, otherFeeCents: 0 },
    );
    expect(money.adcvdFoldedIntoDuty).toBe(true);
    expect(money.adcvdDepositsCents).toBe(834_612);
    // Still shown as its own row, so "additional" excludes it.
    expect(money.additionalDutiesCents).toBe(1_953_300);
    expect(money.dutiesAndFeesCents).toBe(
      2_453_300 + 834_612 + 65_086 + 12_000,
    );
  });

  it("tolerates a header a few cents off either convention", () => {
    const money = deriveEntryMoney(
      {
        totalDutyCents: 2_453_303,
        totalBaseDutyCents: 500_000,
        mpfCents: 0,
        hmfCents: 0,
      },
      { dutyCents: 2_453_300, adcvdCents: 834_612, otherFeeCents: 0 },
    );
    expect(money.adcvdFoldedIntoDuty).toBe(false);
    expect(money.dutiesAndFeesCents).toBe(2_453_303 + 834_612);
  });

  it("is null without a header duty total, and ignores a missing base", () => {
    const money = deriveEntryMoney(
      {
        totalDutyCents: null,
        totalBaseDutyCents: null,
        mpfCents: 3_964,
        hmfCents: 1_430,
      },
      { dutyCents: 0, adcvdCents: 0, otherFeeCents: 854 },
    );
    expect(money.dutiesAndFeesCents).toBeNull();
    expect(money.additionalDutiesCents).toBeNull();
    expect(money.otherFeesCents).toBe(854);

    expect(
      deriveEntryMoney(
        { ...cotton, totalBaseDutyCents: null },
        { dutyCents: 466_875, adcvdCents: 0, otherFeeCents: 854 },
      ),
    ).toMatchObject({ additionalDutiesCents: null, dutiesAndFeesCents: 473_123 });
  });

  it("treats missing MPF/HMF as zero, as the old derivation did", () => {
    expect(
      deriveEntryMoney(
        { ...cotton, mpfCents: null, hmfCents: null },
        { dutyCents: 466_875, adcvdCents: 0, otherFeeCents: 0 },
      ).dutiesAndFeesCents,
    ).toBe(466_875);
  });
});
