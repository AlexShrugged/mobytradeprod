// The entry header's money, derived on read and never stored: the 7501's
// block 40 "Total" rebuilt from the stored header facts plus the declared
// line charges the header fields have no slot for.
//
// The header carries block 37 "Duty" (total_duty), the derived base-only
// slice (total_base_duty) and the Block 43 MPF/HMF rows (mpf_amount,
// hmf_amount). Two kinds of money the broker collects print nowhere on the
// header row: AD/CVD deposits (Block 43 codes 012/013, typed antidumping/
// countervailing on the lines) and the USDA commodity assessments CBP
// collects under its other fee class codes (056 cotton, 053 beef, …; typed
// other_fee on the lines). Both have no per-entry minimum or maximum, so the
// line rows ARE the collected figures — unlike MPF, whose line-level 499
// rows are the broker's uncapped workings — and summing them here keeps the
// header tile, the line totals, landed cost and the authority chart adding
// the same rows. Diagnosed 2026-10-06 from ASC 231-7396836-0: a $8.54
// cotton fee (056) on the line and in Block 43, the tile $8.54 short of the
// line; the same shape left 14 ASC entries' AD/CVD deposits out of the tile.
//
// Block 37 usually leaves AD/CVD deposits to block 39, but some broker
// printouts fold them into the duty total, and the reconcile pass accepts
// either convention (processing/reconcile.ts). The header figure is the
// fact, so the deposits are added only when it closes nearer to the sum
// WITHOUT them; "Additional duties" is what remains of the duty total after
// base duty and any folded deposits. Pure: integer cents, no IO.

import type { ChargeTypeValue } from "../db/schema";

export type EntryChargeSums = {
  /** base_duty + additional_duty: block 37's content on the official form. */
  dutyCents: number;
  /** antidumping + countervailing deposits. */
  adcvdCents: number;
  /** other_fee: the commodity assessments and anything else Block 43 lists
   *  beyond MPF, HMF and AD/CVD. */
  otherFeeCents: number;
};

export type EntryHeaderMoney = {
  totalDutyCents: number | null;
  totalBaseDutyCents: number | null;
  mpfCents: number | null;
  hmfCents: number | null;
};

export type EntryMoney = {
  /** Duty total less base duty (and less AD/CVD when the header folds it
   *  in); null when either header figure is unknown. */
  additionalDutiesCents: number | null;
  adcvdDepositsCents: number;
  otherFeesCents: number;
  /** Block 40: duty + AD/CVD deposits + MPF + HMF + other fees; null when
   *  the header carries no duty total. */
  dutiesAndFeesCents: number | null;
  /** The header duty total already includes the AD/CVD deposits. */
  adcvdFoldedIntoDuty: boolean;
};

const ADCVD_TYPES: ReadonlySet<ChargeTypeValue> = new Set([
  "antidumping",
  "countervailing",
]);
const DUTY_TYPES: ReadonlySet<ChargeTypeValue> = new Set([
  "base_duty",
  "additional_duty",
]);

export const EMPTY_CHARGE_SUMS: EntryChargeSums = {
  dutyCents: 0,
  adcvdCents: 0,
  otherFeeCents: 0,
};

const toCents = (amount: string | number): number =>
  Math.round(Number(amount) * 100);

/** Sum one entry's declared line charges by the three header-relevant
 *  classes. Amounts arrive as numeric strings from drizzle or as numbers. */
export function sumEntryCharges(
  charges: Iterable<{ chargeType: ChargeTypeValue; amount: string | number }>,
): EntryChargeSums {
  const sums = { ...EMPTY_CHARGE_SUMS };
  for (const c of charges) {
    const cents = toCents(c.amount);
    if (DUTY_TYPES.has(c.chargeType)) sums.dutyCents += cents;
    else if (ADCVD_TYPES.has(c.chargeType)) sums.adcvdCents += cents;
    else if (c.chargeType === "other_fee") sums.otherFeeCents += cents;
  }
  return sums;
}

export function deriveEntryMoney(
  header: EntryHeaderMoney,
  sums: EntryChargeSums,
): EntryMoney {
  const duty = header.totalDutyCents;
  const adcvd = sums.adcvdCents;
  const folded =
    duty !== null &&
    adcvd > 0 &&
    Math.abs(duty - (sums.dutyCents + adcvd)) <
      Math.abs(duty - sums.dutyCents);
  const base = header.totalBaseDutyCents;
  return {
    additionalDutiesCents:
      duty !== null && base !== null
        ? duty - base - (folded ? adcvd : 0)
        : null,
    adcvdDepositsCents: adcvd,
    otherFeesCents: sums.otherFeeCents,
    dutiesAndFeesCents:
      duty === null
        ? null
        : duty +
          (folded ? 0 : adcvd) +
          (header.mpfCents ?? 0) +
          (header.hmfCents ?? 0) +
          sums.otherFeeCents,
    adcvdFoldedIntoDuty: folded,
  };
}
