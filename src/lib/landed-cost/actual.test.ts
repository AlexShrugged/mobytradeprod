import { describe, expect, it } from "vitest";

import {
  computeActualLandedCost,
  type ActualChargeInput,
} from "./actual";

function charge(over: Partial<ActualChargeInput>): ActualChargeInput {
  return {
    chargeType: "base_duty",
    amountCents: 0,
    htsCode: null,
    rate: null,
    ...over,
  };
}

describe("computeActualLandedCost", () => {
  it("sums entered value plus every declared charge exactly", () => {
    const result = computeActualLandedCost(
      { enteredValueCents: 10_000, quantity: 4 },
      [
        charge({ chargeType: "base_duty", amountCents: 400, rate: 0.04 }),
        charge({
          chargeType: "additional_duty",
          amountCents: 2_500,
          htsCode: "9903.88.01",
          rate: 0.25,
        }),
        charge({ chargeType: "mpf", amountCents: 35, htsCode: "499" }),
        charge({ chargeType: "hmf", amountCents: 13, htsCode: "501" }),
      ],
    );

    expect(result.totalCents).toBe(10_000 + 400 + 2_500 + 35 + 13);
    expect(result.perUnitCents).toBe(Math.round(result.totalCents / 4));
    expect(result.incomplete).toBe(false);
    const additional = result.components.find((c) =>
      c.label.startsWith("Additional duty"),
    )!;
    expect(additional.label).toBe("Additional duty (9903.88.01)");
    expect(additional.kind).toBe("duty");
    expect(
      result.components.find((c) => c.label === "MPF")!.kind,
    ).toBe("fee");
  });

  it("includes other_fee in the total (legacy platform dropped it)", () => {
    const result = computeActualLandedCost(
      { enteredValueCents: 10_000, quantity: null },
      [
        charge({ chargeType: "base_duty", amountCents: 400 }),
        charge({ chargeType: "other_fee", amountCents: 275 }),
      ],
    );

    expect(result.totalCents).toBe(10_000 + 400 + 275);
    expect(
      result.components.find((c) => c.label === "Other fee")!.kind,
    ).toBe("fee");
  });

  it("never divides by a null or non-positive quantity", () => {
    const noQty = computeActualLandedCost(
      { enteredValueCents: 1_000, quantity: null },
      [],
    );
    expect(noQty.perUnitCents).toBeNull();

    const zeroQty = computeActualLandedCost(
      { enteredValueCents: 1_000, quantity: 0 },
      [],
    );
    expect(zeroQty.perUnitCents).toBeNull();
  });

  it("rounds per-unit over fractional quantities", () => {
    const result = computeActualLandedCost(
      { enteredValueCents: 1_000, quantity: 2.5 },
      [],
    );
    expect(result.perUnitCents).toBe(400);
  });

  it("extraComponents extend the stack — the freight seam", () => {
    const result = computeActualLandedCost(
      { enteredValueCents: 10_000, quantity: 2 },
      [charge({ chargeType: "base_duty", amountCents: 400 })],
      [
        {
          kind: "freight",
          label: "Ocean freight (allocated)",
          amountCents: 2_000,
          source: "declared",
        },
      ],
    );

    expect(result.totalCents).toBe(12_400);
    expect(result.included).toContain("freight");
    expect(result.excluded).toEqual(["insurance", "brokerage"]);
  });

  it("a null-amount extra component flags the result incomplete", () => {
    const result = computeActualLandedCost(
      { enteredValueCents: 10_000, quantity: 1 },
      [],
      [
        {
          kind: "insurance",
          label: "Insurance (unknown)",
          amountCents: null,
          source: "declared",
        },
      ],
    );

    expect(result.incomplete).toBe(true);
    expect(result.totalCents).toBe(10_000);
  });
});
