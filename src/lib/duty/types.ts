import type {
  HtsRateTypeValue,
  MeasureAuthorityValue,
  MeasureScopeValue,
} from "../db/schema";

// In-memory view of the tariff reference tables, built either from the DB
// (reference.ts) or straight from the seed module (tests, stub processor).
// All rates are decimal fractions (0.25 = 25%); all money is integer cents.

export type HtsRef = {
  code: string; // dotted display form
  codeDigits: string;
  description: string;
  chapter: number;
  rateType: HtsRateTypeValue;
  rate: number | null; // null = specific/compound, not computable in v1
  exemption: boolean;
  tradeMeasureId: string | null;
  // Base-schedule change-tiling window (hts_codes.valid_from/valid_to);
  // null/absent = untiled (Chapter 99 rows, in-memory seed builders). Only
  // rows carried in ReferenceData.baseWindowsByDigits use these — the flat
  // htsByDigits map always holds the CURRENT row.
  validFrom?: string | null;
  validTo?: string | null;
};

export type MeasureRef = {
  id: string;
  name: string;
  authority: MeasureAuthorityValue;
  // Stable legal-program identity (trade_measures.program) — the
  // exclusivity key: at most one measure per program applies to a line.
  // Absent/null = lineage unknown, never deduped. See schema.ts.
  program?: string | null;
  scope: MeasureScopeValue;
  countries: string[] | null; // null = every country of origin
  // Annex-style carve-outs: COO in this list → measure does not apply.
  // Checked after the inclusion list; an unknown COO is NOT excluded
  // (expectations bias toward duty owed). Absent/null = no exclusions.
  countriesExcluded?: string[] | null;
  effectiveDate: string; // ISO date
  endDate: string | null;
  // Sail-date conditions (null = none). The entry window above gates on the
  // ENTRY date; these gate on the entry's resolved sail window — how
  // on-the-water savings clauses are expressed.
  sailedOnOrAfter: string | null;
  sailedOnOrBefore: string | null;
  inLieuOfBaseDuty: boolean;
  ch99Code: string;
  ch99Digits: string;
  // Null = non-ad-valorem (specific/compound) — the measure is still
  // EXPECTED on covered entries (presence-checked), but no amount can be
  // computed; rateText carries the raw text for display.
  rate: number | null;
  // Absent = "ad_valorem" (refs built before the field existed).
  rateType?: HtsRateTypeValue;
  rateText?: string | null;
  // Digits of exemption Chapter 99 rows under this measure; a declared
  // charge on any of these satisfies the measure.
  exclusionDigits: string[];
  prefixes: string[];
  // HTS digit prefixes carved out of the measure entirely (suppresses
  // applicability BEFORE stacking). Only scenario-injected proposed
  // measures set this today — loadReferenceData and the seed never do, so
  // real auditor behavior is untouched.
  exclusionPrefixes?: string[];
};

export type StackingRuleRef = {
  winnerAuthority: MeasureAuthorityValue;
  loserAuthority: MeasureAuthorityValue;
  reason: string;
  effectiveDate: string;
  endDate: string | null;
};

export type ReferenceData = {
  htsByDigits: Map<string, HtsRef>;
  // Base-schedule change-tiling windows per code (chapters 1–97; Chapter 99
  // rows never appear — measure windows govern those). Populated by
  // loadReferenceData; optional so in-memory builders and synthetic test
  // refs keep working — when absent (or when no window matches), base-rate
  // resolution falls back to the current row in htsByDigits, which is
  // byte-identical to the pre-windowing behavior.
  baseWindowsByDigits?: Map<string, HtsRef[]>;
  // Entry-date windows (from the parent measure) in which each exemption
  // Ch99 digits string is actually an exemption. htsByDigits keeps only the
  // row backing the LATEST measure window, so without this map an exemption
  // check is blind to windows — a code exempt under one window would read
  // as exempt (or not) forever. Optional with the same fallback contract:
  // absent → the current htsByDigits row's exemption flag decides.
  exemptionsByDigits?: Map<
    string,
    { effectiveDate: string; endDate: string | null }[]
  >;
  measures: MeasureRef[];
  // Pre-sorted by (effectiveDate, insertion order) — the application order.
  stackingRules: StackingRuleRef[];
};

export type SuppressedMeasure = MeasureRef & {
  suppressedBy: { winnerAuthority: MeasureAuthorityValue; reason: string };
};

/**
 * The entry's resolved sail window: per linked shipment,
 * sailed_on_board_date with ETD as the flagged fallback, min/max'd across
 * all of them (lines are not attributable to a single shipment). Built by
 * resolveSailInfo (sail.ts).
 */
export type SailInfo = {
  earliestSail: string | null; // null = no linked shipment has any date
  latestSail: string | null;
  estimated: boolean; // some shipment fell back to ETD
};

/**
 * How sail-conditioned expectations were grounded. null = no applicable
 * candidate carried a sail condition; "assumed" = a condition could not be
 * decided (missing dates, or a sail window straddling the cutoff on a
 * multi-shipment entry) and defaulted toward duty owed.
 */
export type SailBasis = "exact" | "estimated" | "assumed" | null;

export type ExpectedLineInput = {
  htsDigits: string;
  countryOfOrigin: string | null;
  enteredValueCents: number;
  entryDate: string; // ISO date
  // Omitted/null = sail dates unknown; sail-conditioned measures then
  // resolve conservatively (duty owed) and report sailBasis "assumed".
  sail?: SailInfo | null;
};

export type ExpectedLineCharges = {
  // null = the declared HTS is not in our reference data at all.
  baseDuty: {
    rate: number | null; // schedule rate, kept even when zeroed for display
    amountCents: number | null; // null = non-ad-valorem, not computable
    rateType: HtsRateTypeValue;
  } | null;
  // amountCents null = non-ad-valorem measure — expected (presence-checked)
  // but not computable; mirrors the base-duty contract above.
  measures: (MeasureRef & { amountCents: number | null })[];
  suppressed: SuppressedMeasure[];
  baseDutyZeroedBy: MeasureAuthorityValue | null;
  sailBasis: SailBasis;
};
