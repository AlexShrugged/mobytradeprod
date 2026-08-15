// The savings analyst's output contract: candidate reclassification
// opportunities for ONE catalog part, zod-validated at the tool-call layer
// (report_opportunities). Same doctrine as entry findings: claims with
// citations, never asserted money math — every dollar figure must come from
// the compare_codes calculator, and a candidate is a defensible
// classification for the actual product, never a code shopped for its rate.
//
// Relative imports on purpose — this module runs under the tsx script.

import { z } from "zod";

export const savingsEvidenceSchema = z.object({
  source: z.enum(["schedule", "catalog", "entry_history", "calculation"]),
  /** Field or lookup the quote came from, e.g. "compare_codes(8507.60)". */
  field: z.string().nullable(),
  /** Verbatim value or snippet the claim rests on. */
  quote: z.string(),
});
export type SavingsEvidence = z.infer<typeof savingsEvidenceSchema>;

export const savingsOpportunitySchema = z.object({
  /** The candidate code, dotted display form. */
  candidateHtsCode: z.string(),
  title: z.string(),
  /** Why the candidate is a DEFENSIBLE classification for this product
   *  (GRI reasoning, schedule text), plus the duty mechanics of the win. */
  rationale: z.string(),
  /** Cents per year at the trailing entered-value basis, from
   *  compare_codes; null when the basis was insufficient to estimate. */
  estimatedAnnualSavingsCents: z.number().nullable(),
  evidence: z.array(savingsEvidenceSchema),
  /** What could defeat the candidate: scope notes, CBP rulings risk,
   *  documentation the reclassification would need. */
  risks: z.string(),
  suggestedAction: z.string(),
  /** 0..1 — confidence the candidate survives a classification review. */
  confidence: z.number(),
});
export type SavingsOpportunity = z.infer<typeof savingsOpportunitySchema>;

export const savingsReportSchema = z.object({
  summary: z.string(),
  /** Best-first. Empty = the current classification is already optimal (a
   *  legitimate and common result). */
  opportunities: z.array(savingsOpportunitySchema),
});
export type SavingsReport = z.infer<typeof savingsReportSchema>;
