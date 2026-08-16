// The analyst's output contract: a structured findings report, zod-validated
// at the tool-call layer (report_findings) and again by the parse fallback.
// Findings are claims with citations, never assertions of money math — the
// deterministic calculators stay the source of truth, and relatedAlertKeys
// ties a finding back to the deterministic alert(s) it corroborates so evals
// can score recall mechanically. Nothing here persists in v1.
//
// Relative imports on purpose — this module runs under the tsx eval script.

import { z } from "zod";

export const findingCategorySchema = z.enum([
  "adcvd_discrepancy", // AD/CVD case-number / type-03 inconsistencies
  "fee_error", // MPF/HMF min/max/rate problems
  "coo_inconsistency", // origin conflicts across documents/catalog
  "classification_mismatch", // HTS vs description/document/catalog
  "valuation_concern", // value/quantity/unit-price smells
  "document_inconsistency", // cross-document contradictions not otherwise categorized
  "duty_calculation", // declared-vs-expected duty math (deterministic corroboration)
  "other",
]);
export type FindingCategory = z.infer<typeof findingCategorySchema>;

export const evidenceSchema = z.object({
  source: z.enum(["document", "entry", "reference", "calculation"]),
  /** Required in practice when source is "document" — enforced by prompt,
   *  not schema (structured outputs don't support conditional requireds). */
  documentId: z.string().nullable(),
  /** Field path within the source, e.g. "line_items[0].adcvd_case_number". */
  field: z.string().nullable(),
  /** Verbatim value or snippet the claim rests on. */
  quote: z.string(),
  /** One human sentence saying what this evidence shows — the line a
   *  reviewer reads; the quote is the receipt behind it. */
  statement: z.string(),
});
export type FindingEvidence = z.infer<typeof evidenceSchema>;

export const findingFieldSchema = z.object({
  /** Short field label, e.g. "AD deposit", "Case number", "MPF". */
  field: z.string(),
  /** The value as declared, as a bare value ("$10.18", "not declared",
   *  "A-570-133"); null when nothing was filed for this field. */
  filed: z.string().nullable(),
  /** The value the finding expects, same bare form — no parentheticals or
   *  conditions (enforced by prompt); dollar figures must come from tool
   *  outputs. Null when no expectation is expressible. */
  expected: z.string().nullable(),
});
export type FindingField = z.infer<typeof findingFieldSchema>;

export const findingSchema = z.object({
  category: findingCategorySchema,
  severity: z.enum(["error", "warning", "info"]),
  title: z.string(),
  /** 2-4 sentences of reasoning; specifics live in fields/evidence
   *  (brevity enforced by prompt, not schema). */
  explanation: z.string(),
  /** null = entry-level finding. */
  lineNumber: z.number().nullable(),
  /** The filed-vs-expected diff a broker would correct from — what the
   *  reconciliation UI renders as its field table. Empty when the finding
   *  has no filed/expected framing (pure observations). */
  fields: z.array(findingFieldSchema),
  evidence: z.array(evidenceSchema),
  suggestedAction: z.string(),
  /** 0..1 — numeric bounds are validated client-side by the SDK. */
  confidence: z.number(),
  /** Deterministic alertKeys this finding corroborates; [] = novel. */
  relatedAlertKeys: z.array(z.string()),
});
export type Finding = z.infer<typeof findingSchema>;

export const findingsReportSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
});
export type FindingsReport = z.infer<typeof findingsReportSchema>;
