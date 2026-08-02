// Deterministic duty math. Pure functions over ReferenceData — no DB, no IO,
// and (per the roadmap's design principles) never an LLM output. Money is
// integer cents throughout; rates are decimal fractions.

import type {
  ExpectedLineCharges,
  ExpectedLineInput,
  HtsRef,
  MeasureRef,
  ReferenceData,
  SailBasis,
  StackingRuleRef,
  SuppressedMeasure,
} from "./types";

/** Strip everything but digits: "9903.88.01" -> "99038801". */
export function normalizeHts(code: string): string {
  return code.replace(/\D/g, "");
}

function activeOn(
  date: string,
  effectiveDate: string,
  endDate: string | null,
): boolean {
  return effectiveDate <= date && (endDate === null || date <= endDate);
}

/**
 * Entry-date-aware base-schedule resolution over change-tiling windows
 * (hts_codes.valid_from/valid_to; null valid_to = current). Prefer the row
 * whose window contains the entry date — valid_from <= entryDate AND
 * (valid_to IS NULL OR entryDate <= valid_to); a null valid_from is an
 * untiled row and matches every date — so historical entries audit against
 * the base rates of their day. Fall back to the current row (htsByDigits)
 * when no windows are loaded or none match. In the common case of a single
 * open-ended window this returns exactly the htsByDigits row.
 *
 * Chapter 99 rows never enter baseWindowsByDigits (measure entry/sail
 * windows govern those), so Ch99 lookups always take the fallback path.
 */
export function resolveBaseSchedule(
  htsDigits: string,
  entryDate: string | null,
  ref: ReferenceData,
): HtsRef | undefined {
  if (entryDate) {
    const windows = ref.baseWindowsByDigits?.get(htsDigits);
    const hit = windows?.find(
      (w) =>
        (w.validFrom == null || w.validFrom <= entryDate) &&
        (w.validTo == null || entryDate <= w.validTo),
    );
    if (hit) return hit;
  }
  return ref.htsByDigits.get(htsDigits);
}

/**
 * Authority-level stacking: rules fire in reference order against the
 * current survivor set, so a loser already suppressed cannot go on to win a
 * later rule (legacy-verified semantics).
 */
export function applyStacking(
  candidates: MeasureRef[],
  rules: StackingRuleRef[],
  entryDate: string,
): { applicable: MeasureRef[]; suppressed: SuppressedMeasure[] } {
  const applicable = [...candidates];
  const suppressed: SuppressedMeasure[] = [];

  for (const rule of rules) {
    if (!activeOn(entryDate, rule.effectiveDate, rule.endDate)) continue;
    if (!applicable.some((m) => m.authority === rule.winnerAuthority)) continue;

    for (let i = applicable.length - 1; i >= 0; i--) {
      if (applicable[i].authority !== rule.loserAuthority) continue;
      const [loser] = applicable.splice(i, 1);
      suppressed.push({
        ...loser,
        suppressedBy: {
          winnerAuthority: rule.winnerAuthority,
          reason: rule.reason,
        },
      });
    }
  }

  return { applicable, suppressed };
}

/**
 * Which trade measures should appear on a declaration line, given its HTS,
 * country of origin, entry date, and sail window. Gate order mirrors the
 * legacy engine: active window -> product scope (all-products or prefix
 * match) -> country of origin (null = all) -> sail conditions -> stacking.
 *
 * Sail gate semantics (measures are always liability rows — exemption
 * Chapter 99 rows never become MeasureRefs): a sail-conditioned measure is
 * dropped only when provably NO linked shipment falls in its window;
 * missing dates or a straddling multi-shipment window keep it applicable
 * and mark the result "assumed" (conservative: duty owed). With a single
 * shipment, earliest == latest and this collapses to plain cutoff checks.
 */
export function resolveExpectedMeasures(
  input: Pick<
    ExpectedLineInput,
    "htsDigits" | "countryOfOrigin" | "entryDate" | "sail"
  >,
  ref: ReferenceData,
): {
  applicable: MeasureRef[];
  suppressed: SuppressedMeasure[];
  sailBasis: SailBasis;
} {
  const sail = input.sail ?? null;
  let sailEvaluated = false;
  let sailAssumed = false;

  const candidates = ref.measures.filter((m) => {
    if (!activeOn(input.entryDate, m.effectiveDate, m.endDate)) return false;
    if (
      m.scope !== "all_products" &&
      !m.prefixes.some((p) => input.htsDigits.startsWith(p))
    ) {
      return false;
    }
    // Carve-outs remove the line from the measure before stacking, so an
    // excluded line's measure can never win or lose a stacking rule.
    if (m.exclusionPrefixes?.some((p) => input.htsDigits.startsWith(p))) {
      return false;
    }
    if (m.countries !== null) {
      if (input.countryOfOrigin === null) return false;
      if (!m.countries.includes(input.countryOfOrigin)) return false;
    }
    if (m.sailedOnOrAfter !== null || m.sailedOnOrBefore !== null) {
      sailEvaluated = true;
      if (m.sailedOnOrAfter !== null) {
        if (sail?.latestSail == null) sailAssumed = true;
        else if (sail.latestSail < m.sailedOnOrAfter) return false;
        else if (sail.earliestSail! < m.sailedOnOrAfter) sailAssumed = true;
      }
      if (m.sailedOnOrBefore !== null) {
        if (sail?.earliestSail == null) sailAssumed = true;
        else if (sail.earliestSail > m.sailedOnOrBefore) return false;
        else if (sail.latestSail! > m.sailedOnOrBefore) sailAssumed = true;
      }
    }
    return true;
  });

  // Sail-tiled siblings share a Chapter 99 code (entry windows always tile,
  // so only sail partitions can co-survive). When the sail window can't
  // pick a side, both pass — keep the costlier one so expectations never
  // double-charge, and call the choice out as an assumption.
  const byDigits = new Map<string, number>();
  const deduped: MeasureRef[] = [];
  for (const m of candidates) {
    const at = byDigits.get(m.ch99Digits);
    if (at === undefined) {
      byDigits.set(m.ch99Digits, deduped.length);
      deduped.push(m);
    } else {
      sailAssumed = true;
      if (m.rate > deduped[at].rate) deduped[at] = m;
    }
  }

  const sailBasis: SailBasis = !sailEvaluated
    ? null
    : sailAssumed
      ? "assumed"
      : sail?.estimated
        ? "estimated"
        : "exact";

  return {
    ...applyStacking(deduped, ref.stackingRules, input.entryDate),
    sailBasis,
  };
}

/**
 * The full expected charge picture for one declaration line: base duty from
 * the schedule plus one charge per surviving measure. MPF/HMF are absent by
 * design — they are ingested facts, never computed (CBP per-entry minimums
 * and caps make line-level fee math wrong).
 */
export function computeExpectedCharges(
  line: ExpectedLineInput,
  ref: ReferenceData,
): ExpectedLineCharges {
  const { applicable, suppressed, sailBasis } = resolveExpectedMeasures(
    line,
    ref,
  );

  const inLieu = applicable.find((m) => m.inLieuOfBaseDuty) ?? null;
  // Base rates are entry-date-aware: the schedule row of the entry's day,
  // not necessarily today's (change-tiling windows; see resolveBaseSchedule).
  const schedule = resolveBaseSchedule(line.htsDigits, line.entryDate, ref);

  let baseDuty: ExpectedLineCharges["baseDuty"] = null;
  if (schedule && schedule.chapter < 98) {
    if (schedule.rateType === "free") {
      baseDuty = { rate: 0, amountCents: 0, rateType: "free" };
    } else if (schedule.rateType === "ad_valorem" && schedule.rate !== null) {
      baseDuty = {
        rate: schedule.rate,
        amountCents: inLieu
          ? 0
          : Math.round(schedule.rate * line.enteredValueCents),
        rateType: "ad_valorem",
      };
    } else {
      // Specific/compound/other: known but not computable in v1.
      baseDuty = { rate: null, amountCents: null, rateType: schedule.rateType };
    }
  }

  return {
    baseDuty,
    measures: applicable.map((m) => ({
      ...m,
      amountCents: Math.round(m.rate * line.enteredValueCents),
    })),
    suppressed,
    baseDutyZeroedBy: inLieu ? inLieu.authority : null,
    sailBasis,
  };
}
