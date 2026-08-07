// Pure dollar-impact derivation for audit alerts: (alert, line snapshot,
// reference data) -> signed integer cents. Positive = the importer overpaid
// (recoverable); negative = underpaid (exposure). Derived on read, never
// stored, so a reference-data change never leaves a stale number behind.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import { computeExpectedCharges } from "../duty/calculator";
import type {
  ExpectedLineCharges,
  ReferenceData,
  SailInfo,
} from "../duty/types";

export type ImpactLineSnapshot = {
  htsCodeDigits: string;
  countryOfOrigin: string | null;
  enteredValueCents: number;
  /** Catalog code the auditor compares against, AS OF the entry date —
   *  null unless the part is non-draft with a committed window. */
  catalogHtsDigits: string | null;
  /** Catalog code under the CURRENT classification window — the
   *  counterfactual behind the reclassified-after-filing signal. */
  catalogHtsDigitsCurrent: string | null;
  /** Sum of declared duty-type charges (base + additional + AD/CVD);
   *  null when the line has no ingested charges at all. */
  declaredDutyCents: number | null;
};

export type AlertImpact = {
  impactCents: number | null;
  direction: "recoverable" | "exposure" | null;
};

export type ImpactContext = {
  ref: ReferenceData;
  entryDate: string | null;
  sail: SailInfo | null;
  /** False when the entry carries an open data_unreconciled alert — charge
   *  data that cannot be reconciled cannot ground a dollar claim. */
  entryTrusted: boolean;
};

const NO_IMPACT: AlertImpact = { impactCents: null, direction: null };

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function fromCents(cents: number): AlertImpact {
  if (cents === 0) return { impactCents: 0, direction: null };
  return {
    impactCents: cents,
    direction: cents > 0 ? "recoverable" : "exposure",
  };
}

/** Expected duty stack under the CATALOG classification — the counterfactual
 *  behind an HTS discrepancy. `digitsOverride` swaps in a different catalog
 *  code (the current window's, for the reclassified signal) while keeping
 *  the entry-date tariff rules. Null when any required input is missing. */
export function computeCatalogExpected(
  line: ImpactLineSnapshot,
  ctx: ImpactContext,
  digitsOverride?: string,
): ExpectedLineCharges | null {
  const digits = digitsOverride ?? line.catalogHtsDigits;
  if (!digits || !line.countryOfOrigin || !ctx.entryDate) {
    return null;
  }
  return computeExpectedCharges(
    {
      htsDigits: digits,
      countryOfOrigin: line.countryOfOrigin,
      enteredValueCents: line.enteredValueCents,
      entryDate: ctx.entryDate,
      sail: ctx.sail,
    },
    ctx.ref,
  );
}

/** Total computable duty in an expected stack; null when the base duty is
 *  unknown (code absent from reference) or non-ad-valorem. */
export function expectedTotalCents(
  expected: ExpectedLineCharges,
): number | null {
  if (expected.baseDuty === null || expected.baseDuty.amountCents === null) {
    return null;
  }
  return (
    expected.baseDuty.amountCents +
    expected.measures.reduce((sum, m) => sum + m.amountCents, 0)
  );
}

export function computeAlertImpact(
  alert: { alertType: string; details: Record<string, unknown> | null },
  line: ImpactLineSnapshot | null,
  ctx: ImpactContext,
): AlertImpact {
  const d = alert.details;
  switch (alert.alertType) {
    case "amount_mismatch": {
      const actual = num(d?.actual_amount);
      const expected = num(d?.expected_amount);
      if (actual === null || expected === null) return NO_IMPACT;
      return fromCents(Math.round((actual - expected) * 100));
    }
    case "rate_mismatch": {
      // details carry no dollar figure — recompute the implied delta the
      // severity ladder used: (actual - expected) x entered value.
      const actual = num(d?.actual_rate);
      const expected = num(d?.expected_rate);
      if (actual === null || expected === null || line === null) {
        return NO_IMPACT;
      }
      return fromCents(
        Math.round((actual - expected) * line.enteredValueCents),
      );
    }
    case "missing_measure": {
      const expected = num(d?.expected_amount);
      if (expected === null) return NO_IMPACT;
      return fromCents(-Math.round(expected * 100));
    }
    case "unexpected_measure": {
      // Only a stacking-suppressed charge is a claimable overpayment; a
      // coverage gap ("our reference does not show...") proves nothing.
      const actual = num(d?.actual_amount);
      if (actual === null || !d?.stacking_reason) return NO_IMPACT;
      return fromCents(Math.round(actual * 100));
    }
    case "hts_discrepancy": {
      if (!line || line.declaredDutyCents === null || !ctx.entryTrusted) {
        return NO_IMPACT;
      }
      const expected = computeCatalogExpected(line, ctx);
      if (!expected) return NO_IMPACT;
      const total = expectedTotalCents(expected);
      if (total === null) return NO_IMPACT;
      return fromCents(line.declaredDutyCents - total);
    }
    case "hts_reclassified": {
      // What the line WOULD owe under today's classification at its own
      // entry-date tariff rules; positive = duty recoverable if the
      // reclassification applies retroactively.
      if (!line || line.declaredDutyCents === null || !ctx.entryTrusted) {
        return NO_IMPACT;
      }
      if (!line.catalogHtsDigitsCurrent) return NO_IMPACT;
      const expected = computeCatalogExpected(
        line,
        ctx,
        line.catalogHtsDigitsCurrent,
      );
      if (!expected) return NO_IMPACT;
      const total = expectedTotalCents(expected);
      if (total === null) return NO_IMPACT;
      return fromCents(line.declaredDutyCents - total);
    }
    case "value_mismatch": {
      // Only the CI-vs-entry value rules ground a dollar claim — they mark
      // themselves by embedding the effective ad-valorem duty rate of the
      // affected entry lines. Rule 6 (header vs line sum) and rule 8
      // (invoice internal consistency) carry no rate and stay impact-free.
      // expected = the CI (document truth); actual = the filed entry — so
      // over-declared value means duty overpaid (recoverable), under means
      // exposure.
      const expected = num(d?.expected_amount);
      const actual = num(d?.actual_amount);
      const rate = num(d?.effective_duty_rate);
      if (expected === null || actual === null || rate === null) {
        return NO_IMPACT;
      }
      // The rate derives from DECLARED charges — untrusted charge data
      // cannot ground a dollar claim.
      if (!ctx.entryTrusted) return NO_IMPACT;
      return fromCents(Math.round((actual - expected) * 100 * rate));
    }
    // coo_discrepancy: the declared origin is the customs fact the money
    // rules already ran on; a counterfactual under the catalog origin needs
    // human evidence before a dollar is claimable. The remaining types —
    // data_unreconciled, sail_date_assumption, quantity_discrepancy,
    // invoice_sku_missing, invoice_comparison_skipped, and
    // invoice_hts_mismatch (a supplier's printed code is not authoritative
    // enough to ground a duty counterfactual) — carry no directional claim
    // either.
    default:
      return NO_IMPACT;
  }
}
