// Measure-extraction interface: proposes dates/countries/rates for staged
// Chapter 99 revisions from their prose, with per-field confidence and
// verbatim evidence. Implementations NEVER touch reference tables — output
// lands only in measure_revisions.proposed/evidence (staging), and apply.ts
// still writes exactly what the reviewer confirmed. Mirrors the document
// processor's optional-AI pattern: real model when ANTHROPIC_API_KEY is
// set, deterministic heuristics otherwise.

import type { MeasureAuthorityValue } from "../../db/schema";
import type { FrNotice, RevisionEvidence } from "../types";

export type ExtractedField<T> = {
  value: T | null;
  /** 0..1; 0 = "the text does not say". Fields below the merge threshold
   *  stay evidence-only chips in the review card. */
  confidence: number;
  /** Verbatim snippet backing the value, for the reviewer. */
  evidence: string | null;
};

export type MeasureExtraction = {
  ch99Code: string;
  effectiveDate: ExtractedField<string>; // ISO date
  endDate: ExtractedField<string>;
  sailedOnOrAfter: ExtractedField<string>;
  sailedOnOrBefore: ExtractedField<string>;
  countries: ExtractedField<string[]>; // ISO-2
  rate: ExtractedField<number>; // decimal fraction
  notes: string | null;
  extractor: "stub" | "claude";
  model: string | null;
};

export type MeasureExtractionInput = {
  ch99Code: string;
  authority: MeasureAuthorityValue;
  /** The staged revision's evidence bundle — description, rate texts,
   *  footnotes, and the regex date highlights. */
  evidence: RevisionEvidence;
  /** Recent guard-passing Federal Register notices (title/date/abstract) —
   *  where effective dates usually live in prose. */
  relatedNotices: FrNotice[];
};

export interface MeasureExtractor {
  /** Batch extraction, same order/length as inputs. Implementations must
   *  never throw for a single bad row — degrade that row (or the whole
   *  remainder) to the deterministic stub instead; a sync must never fail
   *  because of extraction. */
  extract(inputs: MeasureExtractionInput[]): Promise<MeasureExtraction[]>;
}
