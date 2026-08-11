// Extractor selection, mirroring processing/index.ts's getProcessor: the
// real model when ANTHROPIC_API_KEY is set, the deterministic stub
// otherwise — everything downstream sees only the MeasureExtractor
// interface, so swapping is an env change, not a code change.

import { isProdRuntime } from "@/lib/env";

import { ClaudeMeasureExtractor } from "./claude";
import { StubMeasureExtractor } from "./stub";
import type { MeasureExtractor } from "./types";

// On Vercel the stub is refused: it fabricates structured measure data into
// the review queue, and fabricated rates in a tariff product are worse than
// a failed sync leg (the sync already treats extractor failure as its
// designed soft-fail path).
export function getMeasureExtractor(): MeasureExtractor {
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeMeasureExtractor();
  if (isProdRuntime()) {
    throw new Error(
      "ANTHROPIC_API_KEY is required on Vercel — refusing the stub measure extractor.",
    );
  }
  return new StubMeasureExtractor();
}
