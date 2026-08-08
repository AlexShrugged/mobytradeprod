// Extractor selection, mirroring processing/index.ts's getProcessor: the
// real model when ANTHROPIC_API_KEY is set, the deterministic stub
// otherwise — everything downstream sees only the MeasureExtractor
// interface, so swapping is an env change, not a code change.

import { ClaudeMeasureExtractor } from "./claude";
import { StubMeasureExtractor } from "./stub";
import type { MeasureExtractor } from "./types";

export function getMeasureExtractor(): MeasureExtractor {
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeMeasureExtractor();
  return new StubMeasureExtractor();
}
