// Prospective landed cost: what importing one unit of a catalog part costs
// under today's (or any given date's) tariff rules. Reuses the deterministic
// duty calculator — ad-valorem math is linear, so computing at unit-cost
// scale is exact per-unit math.
//
// Relative imports on purpose: this module is reachable from the tsx-run
// seed script, which must not depend on bundler path aliases.

import { computeExpectedCharges } from "../duty/calculator";
import { HMF_RATE, MPF_RATE } from "../duty/fees";
import type { ReferenceData } from "../duty/types";
import { formatRate } from "../format";
import { assembleLandedCost } from "./assemble";
import type { CostComponent, LandedCost } from "./types";

export type EstimateInput = {
  unitCostCents: number | null;
  htsDigits: string | null; // digits-only (normalizeHts)
  countryOfOrigin: string | null;
};

export type EstimateOptions = {
  /** Include MPF/HMF at nominal rates (default true). CBP applies per-entry
   * minimums and caps that a single-part estimate cannot know. */
  includeFees?: boolean;
};

const FEE_CAP_NOTE = "Nominal rate; CBP applies per-entry minimums and caps";

/**
 * Estimated landed cost for one unit of a part, or null when the part lacks
 * the inputs (unit cost or HTS code) to estimate at all. An HTS code that is
 * missing from the reference schedule still estimates — country-wide
 * measures apply regardless — but the base duty component is null and the
 * result is flagged `incomplete`.
 */
export function computeEstimatedLandedCost(
  part: EstimateInput,
  ref: ReferenceData,
  asOfDate: string,
  opts: EstimateOptions = {},
): LandedCost | null {
  if (part.unitCostCents === null || !part.htsDigits) return null;
  const includeFees = opts.includeFees ?? true;

  const expected = computeExpectedCharges(
    {
      htsDigits: part.htsDigits,
      countryOfOrigin: part.countryOfOrigin,
      enteredValueCents: part.unitCostCents,
      entryDate: asOfDate,
    },
    ref,
  );

  const components: CostComponent[] = [
    {
      kind: "merchandise",
      label: "Merchandise (unit cost)",
      amountCents: part.unitCostCents,
      source: "estimated",
    },
  ];

  if (expected.baseDuty === null) {
    components.push({
      kind: "duty",
      label: "Base duty",
      amountCents: null,
      source: "computed",
      rate: null,
      note: "HTS code not in the reference schedule",
    });
  } else if (expected.baseDuty.amountCents === null) {
    components.push({
      kind: "duty",
      label: `Base duty (${expected.baseDuty.rateType})`,
      amountCents: null,
      source: "computed",
      rate: null,
      note: "Specific/compound rate — not computable per unit value",
    });
  } else {
    components.push({
      kind: "duty",
      label:
        expected.baseDuty.rateType === "free"
          ? "Base duty (Free)"
          : `Base duty (${formatRate(expected.baseDuty.rate)})`,
      amountCents: expected.baseDuty.amountCents,
      source: "computed",
      rate: expected.baseDuty.rate,
      note: expected.baseDutyZeroedBy
        ? `Zeroed: an in-lieu-of measure (${expected.baseDutyZeroedBy}) replaces the base duty`
        : undefined,
    });
  }

  for (const m of expected.measures) {
    components.push({
      kind: "duty",
      label: `${m.name} (${formatRate(m.rate)})`,
      amountCents: m.amountCents,
      source: "computed",
      rate: m.rate,
    });
  }

  if (includeFees) {
    components.push(
      {
        kind: "fee",
        label: "MPF (est.)",
        amountCents: Math.round(MPF_RATE * part.unitCostCents),
        source: "estimated",
        rate: MPF_RATE,
        note: FEE_CAP_NOTE,
      },
      {
        kind: "fee",
        label: "HMF (est.)",
        amountCents: Math.round(HMF_RATE * part.unitCostCents),
        source: "estimated",
        rate: HMF_RATE,
        note: `${FEE_CAP_NOTE}; ocean shipments only`,
      },
    );
  }

  return assembleLandedCost(components, 1);
}
