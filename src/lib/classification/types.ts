// HTS classification behind a swappable interface (design principle 5): the
// deterministic stub today, a Claude-backed classifier later, no UI churn.
// A classifier only ever *proposes* — ranked candidates with reasoning.
// Committing a code to the catalog is always a human decision recorded
// through the review queue (design principle 3).
//
// Relative imports on purpose: reachable from the tsx-run seed script.

import type { ReferenceData } from "../duty/types";

export type ClassifyInput = {
  sku: string;
  name: string;
  description: string | null;
  /** Distinct origins across the part's (vendor, COO) source rows, sorted.
   *  Classification is per-product — origin is context, not a decider — but
   *  a real classifier may use it to sanity-check candidates. */
  countriesOfOrigin: string[];
  /** The committed catalog code, if any. Provisional auto-selects are not
   *  committed and must be passed as null. */
  currentHtsCode: string | null;
};

export type CandidateSuggestion = {
  code: string; // dotted display form
  codeDigits: string;
  confidence: number; // 0..1
  reason: string;
};

export type ClassifyOutcome = "certain" | "ambiguous" | "none";

export type ClassifyResult = {
  outcome: ClassifyOutcome;
  /** Ranked best-first; array index is the stored position. Empty for
   *  outcome "none". Product codes only — never chapter 98/99. */
  candidates: CandidateSuggestion[];
  reasoning: string;
  classifier: string; // "stub" | "claude"
};

export interface Classifier {
  /** `ref` grounds candidates against the tariff schedule, keeping the stub
   *  pure and giving a future real classifier the same footing. */
  classify(input: ClassifyInput, ref: ReferenceData): Promise<ClassifyResult>;
}
