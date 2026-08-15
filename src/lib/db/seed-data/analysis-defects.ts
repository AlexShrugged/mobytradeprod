// Ground truth for the AI entry analyst's eval (scripts/analyze-entry.ts):
// the defects deliberately planted in seed entries that NO deterministic rule
// can see — seed.ts asserts those entries audit clean. A defect scores a HIT
// when a finding lands in an accepted category on the right line.

import type { FindingCategory } from "../../analysis/findings";

export type PlantedAnalysisDefect = {
  key: "mpf_below_minimum" | "adcvd_case_mismatch" | "description_hts_mismatch";
  entryNumber: string;
  /** null = an entry-level finding is acceptable. */
  lineNumber: number | null;
  acceptedCategories: FindingCategory[];
  /** What a correct finding says — printed in the eval report. */
  description: string;
};

export const PLANTED_ANALYSIS_DEFECTS: PlantedAnalysisDefect[] = [
  {
    key: "mpf_below_minimum",
    entryNumber: "231-4501352-6",
    lineNumber: null,
    acceptedCategories: ["fee_error"],
    description:
      "Declared MPF of $10.18 is the uncapped ad valorem amount; the statutory per-entry minimum should have been applied.",
  },
  {
    key: "adcvd_case_mismatch",
    entryNumber: "231-4501358-3",
    lineNumber: 1,
    acceptedCategories: ["adcvd_discrepancy", "document_inconsistency"],
    description:
      "Type 03 entry: the 7501 references AD/CVD case A-570-121 while commercial invoice INV-2026-215 prints A-570-133.",
  },
  {
    key: "description_hts_mismatch",
    entryNumber: "231-4501364-1",
    lineNumber: 2,
    acceptedCategories: ["classification_mismatch"],
    description:
      'Line 2 is described as "48V 10Ah Range-Extender Lithium Battery" but filed under saddle code 8714.95.0000 (301 List 3 at 7.5% instead of the battery heading at 25%).',
  },
];
