// Deterministic extraction from the same heuristics the differ already
// runs: rate-parse for the rate, detectCountries for origin scope, and the
// sail-clause highlighter for date candidates. Confidence is deliberately
// low on dates (below the merge threshold) — heuristics propose, never
// assert; their output renders as evidence chips, not auto-filled fields.

import { detectCountries } from "../differ";
import { parseGeneralRate } from "../rate-parse";
import type { SailClauseCandidate } from "../types";
import type {
  ExtractedField,
  MeasureExtraction,
  MeasureExtractionInput,
  MeasureExtractor,
} from "./types";

/** Below the 0.5 merge threshold on purpose: a regex hit is a hint. */
const DATE_CONFIDENCE = 0.4;
const COUNTRY_CONFIDENCE = 0.6;

const empty = <T,>(): ExtractedField<T> => ({
  value: null,
  confidence: 0,
  evidence: null,
});

function dateField(
  highlights: SailClauseCandidate[],
  kind: SailClauseCandidate["kind"],
): ExtractedField<string> {
  const hit = highlights.find((h) => h.kind === kind);
  if (!hit) return empty();
  return { value: hit.isoDate, confidence: DATE_CONFIDENCE, evidence: hit.snippet };
}

export class StubMeasureExtractor implements MeasureExtractor {
  async extract(
    inputs: MeasureExtractionInput[],
  ): Promise<MeasureExtraction[]> {
    return this.extractChunk(inputs);
  }

  /** Synchronous batch form — the Claude extractor's per-chunk fallback. */
  extractChunk(inputs: MeasureExtractionInput[]): MeasureExtraction[] {
    return inputs.map((input) => this.extractOne(input));
  }

  extractOne(input: MeasureExtractionInput): MeasureExtraction {
    const { evidence } = input;
    const parsed = parseGeneralRate(evidence.general);
    const rate: ExtractedField<number> =
      parsed.kind === "additional" || parsed.kind === "ad_valorem"
        ? { value: parsed.rate, confidence: 0.9, evidence: evidence.general }
        : parsed.kind === "none"
          ? { value: 0, confidence: 0.95, evidence: evidence.general }
          : empty();

    const countries = detectCountries(evidence.description);
    const highlights = evidence.highlights ?? [];

    return {
      ch99Code: input.ch99Code,
      effectiveDate: dateField(highlights, "entry_on_or_after"),
      // "entered before D" bounds the window exclusively; the reviewer
      // converts to the inclusive D−1 via the existing chip behavior — the
      // stub reports the raw date and says so.
      endDate: (() => {
        const f = dateField(highlights, "entry_before");
        return f.value
          ? { ...f, evidence: `${f.evidence} (exclusive bound — window ends the day before)` }
          : f;
      })(),
      sailedOnOrAfter: dateField(highlights, "sail_on_or_after"),
      sailedOnOrBefore: (() => {
        const f = dateField(highlights, "sail_before");
        return f.value
          ? { ...f, evidence: `${f.evidence} (exclusive bound — sailed on/before the day before)` }
          : f;
      })(),
      countries: countries
        ? {
            value: countries,
            confidence: COUNTRY_CONFIDENCE,
            evidence: evidence.description.match(/products?\s+of\s+[^.;:(]{3,80}/i)?.[0] ?? null,
          }
        : empty(),
      rate,
      notes: null,
      extractor: "stub",
      model: null,
    };
  }
}
