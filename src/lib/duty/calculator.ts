// Deterministic duty math. Pure functions over ReferenceData — no DB, no IO,
// and (per the roadmap's design principles) never an LLM output. Money is
// integer cents throughout; rates are decimal fractions.

import type { HtsRateTypeValue } from "../db/schema";
import { lapsedProgram } from "./preference-programs";
import { resolveSpiEligibility } from "./special-rates";
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
 * Whether a declared Ch99 digits string is an exemption ACTIVE on the entry
 * date. Resolves against exemptionsByDigits (the exemption's measure
 * windows); when that map is absent — in-memory builders, synthetic test
 * refs — falls back to the current htsByDigits row's exemption flag, the
 * pre-windowing behavior.
 */
export function isExemptionActive(
  htsDigits: string,
  entryDate: string,
  ref: ReferenceData,
): boolean {
  const windows = ref.exemptionsByDigits?.get(htsDigits);
  if (windows === undefined) {
    return ref.exemptionsByDigits
      ? false
      : (ref.htsByDigits.get(htsDigits)?.exemption ?? false);
  }
  return windows.some((w) => activeOn(entryDate, w.effectiveDate, w.endDate));
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

/** The column-1 rate that governs a line before any Chapter 99 measure:
 *  the schedule row of the entry's day, with an eligible SPI claim's
 *  special rate swapped in. `rateType` null = the code is not in the
 *  reference (or is itself a Chapter 98/99 code) — no base duty at all;
 *  `rate` null with a rateType = known but not computable (specific/
 *  compound). Shared by the base-duty expectation and the ceiling gate so
 *  both read the same rate. */
export type ColumnOneRate = {
  schedule: HtsRef | undefined;
  rate: number | null;
  rateType: HtsRateTypeValue | null;
  claim: ExpectedLineCharges["baseDutyClaim"];
};

export function resolveColumnOneRate(
  line: Pick<ExpectedLineInput, "htsDigits" | "entryDate" | "spi">,
  ref: ReferenceData,
): ColumnOneRate {
  const schedule = resolveBaseSchedule(line.htsDigits, line.entryDate, ref);
  if (!schedule || schedule.chapter >= 98) {
    return { schedule, rate: null, rateType: null, claim: null };
  }
  // A declared SPI is the broker claiming an FTA/GSP preference — the same
  // claim doctrine as a $0 exclusion code. A schedule-supported claim swaps
  // the special rate in as the expectation; an unsupported or unverifiable
  // one leaves the general rate standing and lets the audit decide what
  // the claim's status permits it to say.
  const spi = line.spi?.trim() || null;
  let claim: ExpectedLineCharges["baseDutyClaim"] = null;
  if (spi && lapsedProgram(spi, line.entryDate)) {
    // The program was not in force on the entry date (GSP since 2021):
    // the schedule's column still lists it, but the claim prices nothing
    // and the general rate stands — a broker keeping the SPI and paying
    // full duty is filing exactly as CBP's lapse guidance says to.
    claim = { spi, status: "lapsed", rateText: null };
  } else if (spi) {
    const eligibility = resolveSpiEligibility(schedule.col1Special, spi);
    claim = {
      spi,
      status: eligibility.status,
      rateText: eligibility.status === "eligible" ? eligibility.rateText : null,
    };
    if (eligibility.status === "eligible") {
      // Specific/compound special rate: known but not computable.
      if (eligibility.rate === null) {
        return { schedule, rate: null, rateType: "other", claim };
      }
      return {
        schedule,
        rate: eligibility.rate,
        rateType: eligibility.rate === 0 ? "free" : "ad_valorem",
        claim,
      };
    }
  }
  if (schedule.rateType === "free") {
    return { schedule, rate: 0, rateType: "free", claim };
  }
  if (schedule.rateType === "ad_valorem" && schedule.rate !== null) {
    return { schedule, rate: schedule.rate, rateType: "ad_valorem", claim };
  }
  // Specific/compound/other: known but not computable in v1.
  return { schedule, rate: null, rateType: schedule.rateType, claim };
}

/**
 * Which trade measures should appear on a declaration line, given its HTS,
 * country of origin, entry date, and sail window. Gate order mirrors the
 * legacy engine: active window -> product scope (all-products or prefix
 * match) -> country of origin (null = all) -> column-1 rate gate (ceiling
 * headings) -> sail conditions -> stacking.
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
    "htsDigits" | "countryOfOrigin" | "entryDate" | "sail" | "spi"
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
  // Resolved once per line for the ceiling gate; the same resolution feeds
  // the base-duty expectation in computeExpectedCharges.
  const col1Rate = resolveColumnOneRate(input, ref).rate;

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
    // Annex-style carve-outs ("all countries except…"). An unknown COO is
    // NOT excluded — expectations bias toward duty owed, same as the sail
    // assumptions below.
    if (
      m.countriesExcluded &&
      input.countryOfOrigin !== null &&
      m.countriesExcluded.includes(input.countryOfOrigin)
    ) {
      return false;
    }
    // Column-1 rate gate: a ceiling heading reaches only lines whose
    // column-1 rate is below its threshold — at or above it, the sibling
    // exemption heading files at $0 and the column-1 rate stands. An
    // unknown or non-computable column-1 rate cannot be gated and keeps
    // the measure (expectations bias toward duty owed, same as sail).
    if (
      m.col1RateBelow != null &&
      col1Rate !== null &&
      col1Rate >= m.col1RateBelow - 1e-9
    ) {
      return false;
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
      // Null rates (presence-only measures) compare as cheapest, so the
      // computable sibling wins the "costlier" tie-break.
      if ((m.rate ?? -1) > (deduped[at].rate ?? -1)) deduped[at] = m;
    }
  }

  // Program exclusivity: one legal program ("the reciprocal tariff", "the
  // fentanyl IEEPA order") is published as several Chapter 99 headings that
  // partition a line's fate — a worldwide baseline vs country-specific
  // rates, pre/post-escalation windows — and exactly one applies (each
  // heading's article description carves out the others; country rates
  // apply "in lieu of" the baseline). Distinct programs still stack, even
  // under one statute (a China line carried 301 + IEEPA fentanyl + IEEPA
  // reciprocal at once, per CBP's line-sequencing guidance), so the key is
  // trade_measures.program, never authority. Null program = lineage
  // unknown: never deduped. Country-specific headings beat the baseline;
  // remaining ties keep the costlier rate (duty owed), marked as a sail
  // assumption when a sail condition is what left the tie undecided.
  const byProgram = new Map<string, MeasureRef[]>();
  for (const m of deduped) {
    if (!m.program) continue;
    const group = byProgram.get(m.program) ?? [];
    group.push(m);
    byProgram.set(m.program, group);
  }
  const programSuppressed: SuppressedMeasure[] = [];
  const shadowed = new Set<MeasureRef>();
  for (const group of byProgram.values()) {
    if (group.length < 2) continue;
    const specific = group.filter((m) => m.countries !== null);
    const tier = specific.length > 0 ? specific : group;
    if (
      tier.length > 1 &&
      tier.some((m) => m.sailedOnOrAfter !== null || m.sailedOnOrBefore !== null)
    ) {
      sailAssumed = true;
    }
    const winner = tier.reduce((w, m) => {
      const wr = w.rate ?? -1;
      const mr = m.rate ?? -1;
      if (mr > wr) return m;
      if (mr === wr && m.effectiveDate > w.effectiveDate) return m;
      return w;
    });
    for (const m of group) {
      if (m === winner) continue;
      shadowed.add(m);
      programSuppressed.push({
        ...m,
        suppressedBy: {
          winnerAuthority: winner.authority,
          reason: `${winner.name} (${winner.ch99Code}) applies to this line in its place — one charge per tariff program.`,
        },
      });
    }
  }
  const survivors =
    shadowed.size === 0 ? deduped : deduped.filter((m) => !shadowed.has(m));

  const sailBasis: SailBasis = !sailEvaluated
    ? null
    : sailAssumed
      ? "assumed"
      : sail?.estimated
        ? "estimated"
        : "exact";

  const stacked = applyStacking(survivors, ref.stackingRules, input.entryDate);

  // Cross-program statutory carve-outs: a measure whose exemption heading
  // names a trigger program is displaced when a measure of that program
  // survives on the line — the expected filing becomes the $0 exemption
  // heading, not the liability rate (Section 122's 9903.03.06 vs the 232
  // metals programs). Scope-based on purpose: expectations bias toward the
  // costlier correct bundle; the AUDIT is where a declared trigger-family
  // exclusion claim negates the displacement (see rules.ts, carveout).
  // Fixpoint loop: each displacement shrinks the list, so it terminates,
  // and a displaced measure never acts as a trigger afterward.
  const applicable = stacked.applicable;
  const carveoutSuppressed: SuppressedMeasure[] = [];
  for (let displaced = true; displaced; ) {
    displaced = false;
    for (let i = 0; i < applicable.length; i++) {
      const m = applicable[i];
      const carveout = m.carveouts?.find((c) =>
        applicable.some(
          (o) => o !== m && o.program !== null && o.program === c.triggerProgram,
        ),
      );
      if (!carveout) continue;
      const winner = applicable.find(
        (o) => o !== m && o.program === carveout.triggerProgram,
      )!;
      applicable.splice(i, 1);
      carveoutSuppressed.push({
        ...m,
        suppressedBy: {
          winnerAuthority: winner.authority,
          reason: `${winner.name} (${winner.ch99Code}) covers this line, so the statutory carve-out applies in its place — the expected filing is ${carveout.exemptionCode} at $0, not ${m.ch99Code}.`,
          carveout: {
            triggerProgram: carveout.triggerProgram,
            expectedExemptionCode: carveout.exemptionCode,
          },
        },
      });
      displaced = true;
      break;
    }
  }

  return {
    applicable,
    suppressed: [...programSuppressed, ...stacked.suppressed, ...carveoutSuppressed],
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
  // not necessarily today's (change-tiling windows; see resolveBaseSchedule
  // via resolveColumnOneRate). An in-lieu measure — a ceiling heading —
  // replaces the column-1 rate: the amount zeroes, the rate stays for
  // display.
  const col1 = resolveColumnOneRate(line, ref);
  let baseDuty: ExpectedLineCharges["baseDuty"] = null;
  if (col1.rateType !== null) {
    baseDuty =
      col1.rate === null
        ? { rate: null, amountCents: null, rateType: col1.rateType }
        : {
            rate: col1.rate,
            amountCents:
              inLieu || col1.rate === 0
                ? 0
                : Math.round(col1.rate * line.enteredValueCents),
            rateType: col1.rateType,
          };
  }

  return {
    baseDuty,
    // A null rate = non-ad-valorem measure: still expected on the line
    // (presence-checked), amount not computable — same contract as
    // specific/compound base duty above.
    measures: applicable.map((m) => ({
      ...m,
      amountCents:
        m.rate === null ? null : Math.round(m.rate * line.enteredValueCents),
    })),
    suppressed,
    baseDutyZeroedBy: inLieu ? inLieu.authority : null,
    baseDutyReplacedBy: inLieu
      ? { name: inLieu.name, ch99Code: inLieu.ch99Code, rate: inLieu.rate }
      : null,
    baseDutyClaim: col1.claim,
    sailBasis,
  };
}
