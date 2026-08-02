// Per-authority duty bucketing: classifies declared entry_line_charges into
// the authority buckets the legacy platform reported (Section 301, 232
// steel/aluminum, IEEPA, reciprocal, …) and rolls them up per entry.
//
// Resolution precedence, most→least authoritative:
//   1. Our reference data: charge Ch99 digits -> hts_codes.trade_measure_id
//      -> trade_measures.authority. Always wins when the code is known.
//   2. Legacy exact-code lists (CHARGE_HTS_CODES in the legacy entries UI),
//      digit-normalized, plus 9903.01.25 (the reciprocal baseline our own
//      stub declares).
//   3. Prefix buckets, per the legacy reports SQL — with one deliberate
//      correction: legacy lumped 990385% into Section 301 alongside 990388%,
//      but 9903.85.xx are Section 232 aluminum derivative codes (the legacy
//      exact lists never claim 990385, and our reference data files 9903.85.08
//      under 232 aluminum), so 990385 buckets as 232 aluminum here.
//   4. Anything else Chapter 99 -> "other_ch99"; never silently dropped.
//
// Amounts SUM per bucket (legacy reports semantics); rates take the MAX
// (legacy entries-UI semantics). Pure functions, no DB/IO — money in cents.

import type { ChargeTypeValue } from "../db/schema";
import type { ReferenceData } from "./types";

export type DutyBucket =
  | "base_duty"
  | "section_301"
  | "section_232_steel"
  | "section_232_aluminum"
  | "section_232" // prefix-matched 232 where steel/aluminum can't be told apart
  | "ieepa"
  | "reciprocal"
  | "other_ch99"
  | "antidumping"
  | "countervailing"
  | "mpf"
  | "hmf"
  | "other_fee";

/** Display order + labels, mirroring the legacy measure column order. */
export const DUTY_BUCKETS: { bucket: DutyBucket; label: string }[] = [
  { bucket: "base_duty", label: "Base duty" },
  { bucket: "section_301", label: "Section 301" },
  { bucket: "section_232_steel", label: "Section 232 steel" },
  { bucket: "section_232_aluminum", label: "Section 232 aluminum" },
  { bucket: "section_232", label: "Section 232 (unsplit)" },
  { bucket: "ieepa", label: "IEEPA" },
  { bucket: "reciprocal", label: "Reciprocal" },
  { bucket: "other_ch99", label: "Other Ch. 99" },
  { bucket: "antidumping", label: "Antidumping" },
  { bucket: "countervailing", label: "Countervailing" },
  { bucket: "mpf", label: "MPF" },
  { bucket: "hmf", label: "HMF" },
  { bucket: "other_fee", label: "Other fees" },
];

export const BUCKET_LABELS: Record<DutyBucket, string> = Object.fromEntries(
  DUTY_BUCKETS.map((b) => [b.bucket, b.label]),
) as Record<DutyBucket, string>;

/** Buckets that are duty (roll into total_duty), as opposed to fees. */
export const DUTY_BUCKET_SET: ReadonlySet<DutyBucket> = new Set([
  "base_duty",
  "section_301",
  "section_232_steel",
  "section_232_aluminum",
  "section_232",
  "ieepa",
  "reciprocal",
  "other_ch99",
  "antidumping",
  "countervailing",
]);

// Legacy exact lists, digit-normalized (8-digit statistical roots). The
// legacy UI listed each code in 8-digit, dotted, and 10-digit forms; we
// normalize and compare on the 8-digit root instead.
const EXACT_BY_ROOT: Record<string, DutyBucket> = {
  "99038803": "section_301",
  "99038815": "section_301",
  "99030124": "ieepa",
  "99030133": "ieepa",
  "99030125": "reciprocal", // reciprocal baseline (not in legacy lists; see header)
  "99038001": "section_232_steel",
  "99039201": "section_232_steel",
  "99038002": "section_232_aluminum",
  "99038004": "section_232_aluminum",
  "99039202": "section_232_aluminum",
  "99039701": "reciprocal",
};

// Legacy reports prefix buckets (with the 990385 correction; see header).
// Order matters only for readability — prefixes are mutually exclusive.
const PREFIX_BUCKETS: [string, DutyBucket][] = [
  ["990301", "ieepa"],
  ["990302", "reciprocal"],
  ["990388", "section_301"],
  ["990385", "section_232_aluminum"],
  ["990378", "section_232"],
  ["990380", "section_232"],
  ["990381", "section_232"],
  ["990392", "section_232"],
];

const AUTHORITY_TO_BUCKET: Record<string, DutyBucket> = {
  section_301: "section_301",
  section_232_steel: "section_232_steel",
  section_232_aluminum: "section_232_aluminum",
  ieepa: "ieepa",
  reciprocal: "reciprocal",
};

/**
 * Bucket a single declared charge. `htsCodeDigits` is the normalized charge
 * code (Ch99 for measures, "499"/"501" pseudo-codes for fees).
 */
export function resolveChargeBucket(
  chargeType: ChargeTypeValue,
  htsCodeDigits: string | null,
  ref: ReferenceData,
): DutyBucket {
  switch (chargeType) {
    case "base_duty":
      return "base_duty";
    case "mpf":
      return "mpf";
    case "hmf":
      return "hmf";
    case "other_fee":
      return "other_fee";
    case "antidumping":
      return "antidumping";
    case "countervailing":
      return "countervailing";
    case "additional_duty":
      break;
  }

  if (!htsCodeDigits) return "other_ch99";

  // 1. Reference data wins: code -> measure -> authority.
  const refRow = ref.htsByDigits.get(htsCodeDigits);
  if (refRow?.tradeMeasureId) {
    const measure = ref.measures.find((m) => m.id === refRow.tradeMeasureId);
    const bucket = measure ? AUTHORITY_TO_BUCKET[measure.authority] : undefined;
    if (bucket) return bucket;
  }

  // 2. Legacy exact lists on the 8-digit root.
  const root = htsCodeDigits.slice(0, 8);
  const exact = EXACT_BY_ROOT[root];
  if (exact) return exact;

  // 3. Prefix buckets.
  for (const [prefix, bucket] of PREFIX_BUCKETS) {
    if (htsCodeDigits.startsWith(prefix)) return bucket;
  }

  return "other_ch99";
}

export type BucketableCharge = {
  chargeType: ChargeTypeValue;
  htsCodeDigits: string | null;
  /** Decimal-fraction rate as stored ("0.250000"), or null. */
  rate: string | null;
  /** Dollar amount as stored ("2500.00"). */
  amount: string;
};

export type BucketTotal = {
  bucket: DutyBucket;
  label: string;
  amountCents: number;
  /** MAX declared rate in the bucket (legacy entries-UI semantics). */
  maxRate: number | null;
  /** Distinct charge codes seen (dotted forms unavailable; digits). */
  codes: string[];
  chargeCount: number;
};

/**
 * Roll up declared charges into per-authority totals. Returns only buckets
 * that occur, in DUTY_BUCKETS display order. Sums always reconcile with the
 * inputs: every charge lands in exactly one bucket.
 */
export function computeAuthorityBreakdown(
  charges: BucketableCharge[],
  ref: ReferenceData,
): BucketTotal[] {
  const acc = new Map<
    DutyBucket,
    { amountCents: number; maxRate: number | null; codes: Set<string>; n: number }
  >();

  for (const c of charges) {
    const bucket = resolveChargeBucket(c.chargeType, c.htsCodeDigits, ref);
    const entry = acc.get(bucket) ?? {
      amountCents: 0,
      maxRate: null,
      codes: new Set<string>(),
      n: 0,
    };
    entry.amountCents += Math.round(Number(c.amount) * 100);
    if (c.rate !== null) {
      const rate = Number(c.rate);
      if (entry.maxRate === null || rate > entry.maxRate) entry.maxRate = rate;
    }
    if (c.htsCodeDigits) entry.codes.add(c.htsCodeDigits);
    entry.n += 1;
    acc.set(bucket, entry);
  }

  const out: BucketTotal[] = [];
  for (const { bucket, label } of DUTY_BUCKETS) {
    const entry = acc.get(bucket);
    if (!entry) continue;
    out.push({
      bucket,
      label,
      amountCents: entry.amountCents,
      maxRate: entry.maxRate,
      codes: [...entry.codes].sort(),
      chargeCount: entry.n,
    });
  }
  return out;
}

/**
 * Effective duty rate = total duty / entered value (legacy "Total Duty Rate
 * (Combined)" semantics: all duty-type charges in the numerator, null when
 * the denominator is zero/unknown).
 */
export function effectiveDutyRate(
  totalDutyCents: number | null,
  enteredValueCents: number | null,
): number | null {
  if (totalDutyCents === null || !enteredValueCents) return null;
  return totalDutyCents / enteredValueCents;
}
