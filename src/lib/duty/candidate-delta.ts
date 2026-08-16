import { computeExpectedCharges } from "./calculator";
import type { ExpectedLineCharges, ReferenceData } from "./types";

// Duty-rate comparison between a candidate HTS code and a part's current
// one, under today's tariff measures. Pure math over ReferenceData —
// derived on read, never stored (doctrine). The Parts page uses it to tag
// classifier suggestions that would genuinely lower duty.

/** The compare_codes total: base + every computable measure. Null total
 *  means the code isn't in the reference schedule; nonComputable counts
 *  components (specific/compound rates) the math couldn't price. */
export function totalExpectedDutyCents(e: ExpectedLineCharges): {
  totalCents: number | null;
  nonComputable: number;
} {
  if (e.baseDuty === null) return { totalCents: null, nonComputable: 0 };
  const measureCents = e.measures.reduce((s, m) => s + (m.amountCents ?? 0), 0);
  return {
    totalCents: (e.baseDuty.amountCents ?? 0) + measureCents,
    nonComputable:
      e.measures.filter((m) => m.amountCents === null).length +
      (e.baseDuty.amountCents === null ? 1 : 0),
  };
}

// Ad-valorem math is linear in entered value, so a fixed nominal basis
// yields the exact rate delta at any real value. The result is a RATE
// (decimal fraction of entered value), never a dollar figure.
const BASIS_CENTS = 1_000_000;

/** The guaranteed duty-rate saving of a candidate code over the current
 *  one, as a decimal fraction (0.125 = 12.5 points of entered value) — the
 *  minimum across every distinct source COO — or null when the candidate
 *  isn't strictly cheaper or the comparison is undecidable.
 *
 *  Conservative by construction: null when there is no current code, the
 *  candidate IS the current code, no origins exist, any origin is unknown
 *  (a null COO silently drops country-gated measures, which could fake a
 *  saving), either code is missing from the schedule, or the CANDIDATE
 *  side has non-computable components (a hidden charge could erase the
 *  saving). Non-computable components on the CURRENT side are tolerated —
 *  they only understate the current total, never inflate the saving. */
export function candidateDutySavingRate(
  input: {
    candidateDigits: string;
    currentDigits: string | null;
    /** COOs of the part's current sources; null = origin unknown. */
    origins: (string | null)[];
    /** ISO date the measures are evaluated at (today for "current"). */
    asOf: string;
  },
  ref: ReferenceData,
): number | null {
  const { candidateDigits, currentDigits, asOf } = input;
  if (currentDigits === null || candidateDigits === currentDigits) return null;
  if (input.origins.length === 0) return null;
  if (input.origins.some((o) => o === null)) return null;
  const origins = [...new Set(input.origins as string[])];

  let minSavingCents = Infinity;
  for (const coo of origins) {
    const price = (htsDigits: string) =>
      totalExpectedDutyCents(
        computeExpectedCharges(
          {
            htsDigits,
            countryOfOrigin: coo,
            enteredValueCents: BASIS_CENTS,
            entryDate: asOf,
            sail: null,
          },
          ref,
        ),
      );
    const cand = price(candidateDigits);
    const curr = price(currentDigits);
    if (cand.totalCents === null || curr.totalCents === null) return null;
    if (cand.nonComputable > 0) return null;
    const saving = curr.totalCents - cand.totalCents;
    if (saving <= 0) return null;
    minSavingCents = Math.min(minSavingCents, saving);
  }
  return minSavingCents / BASIS_CENTS;
}
