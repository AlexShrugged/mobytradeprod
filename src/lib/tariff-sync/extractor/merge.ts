// The doctrine keeper: folds an extraction into a staged revision. The
// differ's deterministic values always win — extraction only fills nulls,
// and only above a confidence floor. The full extraction lands in
// evidence.extraction either way, so the review card can render per-field
// confidence chips and snippets even for fields that stayed evidence-only.
// contentHash is untouched: it hashes SOURCE fields only, which is what
// keeps re-runs idempotent.

import type { ProposedRevision } from "../types";
import type { MeasureExtraction } from "./types";

/** Fields fill into the proposal only at or above this confidence; below
 *  it they stay evidence chips. The stub's date confidence (0.4) sits
 *  deliberately under this floor. */
export const FILL_CONFIDENCE = 0.5;

const DATE_FIELDS = [
  "effectiveDate",
  "endDate",
  "sailedOnOrAfter",
  "sailedOnOrBefore",
] as const;

export function mergeExtraction(
  rev: ProposedRevision,
  ex: MeasureExtraction,
): ProposedRevision {
  const proposed = { ...rev.proposed };

  for (const field of DATE_FIELDS) {
    const f = ex[field];
    if (
      proposed[field] === null &&
      f.value !== null &&
      f.confidence >= FILL_CONFIDENCE
    ) {
      proposed[field] = f.value;
    }
  }

  if (
    proposed.countries === null &&
    ex.countries.value !== null &&
    ex.countries.confidence >= FILL_CONFIDENCE
  ) {
    proposed.countries = ex.countries.value;
  }

  // Only ad-valorem gaps take a numeric fill — a specific/compound measure
  // (rateType non-ad-valorem) legitimately has rate null and must not gain
  // a decimal fraction the rate text doesn't support.
  if (
    proposed.rate === null &&
    (proposed.rateType ?? "ad_valorem") === "ad_valorem" &&
    ex.rate.value !== null &&
    ex.rate.confidence >= FILL_CONFIDENCE
  ) {
    proposed.rate = ex.rate.value;
  }

  if (proposed.notes === null && ex.notes) {
    proposed.notes = ex.notes;
  }

  return {
    ...rev,
    proposed,
    evidence: { ...rev.evidence, extraction: ex },
  };
}
