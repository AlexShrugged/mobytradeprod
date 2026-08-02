// Actual landed cost: what one entry declaration line really cost, built
// from declared facts — entered value plus every charge as ingested from the
// 7501. All charge types count (including other_fee: the legacy platform
// modeled agricultural fees but silently dropped them from landed cost).

import type { ChargeTypeValue } from "../db/schema";
import { assembleLandedCost } from "./assemble";
import type { CostComponent, LandedCost } from "./types";

export type ActualChargeInput = {
  chargeType: ChargeTypeValue;
  amountCents: number;
  htsCode: string | null;
  rate: number | null;
};

const DUTY_TYPES: ReadonlySet<ChargeTypeValue> = new Set([
  "base_duty",
  "additional_duty",
  "antidumping",
  "countervailing",
]);

const CHARGE_LABELS: Record<ChargeTypeValue, string> = {
  base_duty: "Base duty",
  additional_duty: "Additional duty",
  antidumping: "Antidumping duty",
  countervailing: "Countervailing duty",
  mpf: "MPF",
  hmf: "HMF",
  other_fee: "Other fee",
};

/** Bucket a charge type into the landed-cost component kind it belongs to. */
export function chargeKind(chargeType: ChargeTypeValue): "duty" | "fee" {
  return DUTY_TYPES.has(chargeType) ? "duty" : "fee";
}

/**
 * Landed cost of one entry line from its declared facts. `extraComponents`
 * is the extension seam: future ingested costs (freight, insurance,
 * brokerage) allocated to this line join the stack here.
 */
export function computeActualLandedCost(
  line: { enteredValueCents: number; quantity: number | null },
  charges: ActualChargeInput[],
  extraComponents: CostComponent[] = [],
): LandedCost {
  const components: CostComponent[] = [
    {
      kind: "merchandise",
      label: "Entered value",
      amountCents: line.enteredValueCents,
      source: "declared",
    },
  ];

  for (const c of charges) {
    const isAdditional = c.chargeType === "additional_duty";
    components.push({
      kind: chargeKind(c.chargeType),
      label:
        isAdditional && c.htsCode
          ? `${CHARGE_LABELS.additional_duty} (${c.htsCode})`
          : CHARGE_LABELS[c.chargeType],
      amountCents: c.amountCents,
      source: "declared",
      rate: c.rate,
    });
  }

  components.push(...extraComponents);

  return assembleLandedCost(components, line.quantity);
}
