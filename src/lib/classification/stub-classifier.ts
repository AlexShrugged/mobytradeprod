// Deterministic classification stub, story-driven like the stub document
// processor: known demo SKUs get curated suggestions that exercise every
// review path, everything else falls back to hash-ranked schedule siblings
// of the part's current code. Same input → identical output, always.

import { normalizeHts } from "../duty/calculator";
import type { HtsRef, ReferenceData } from "../duty/types";
import type {
  CandidateSuggestion,
  Classifier,
  ClassifyInput,
  ClassifyResult,
} from "./types";

type StoryEntry = {
  outcome: "certain" | "ambiguous";
  reasoning: string;
  candidates: { code: string; confidence: number; reason: string }[];
};

// Demo storylines, keyed by seeded catalog SKUs (see PART_SEED):
// - EB-BRK-HYD: certain suggestion for the brake's schedule sibling — the
//   same code stub-processed 7501s declare on their class-3 discrepancy
//   lines, so accepting it corrects the catalog and auto-clears those
//   hts_discrepancy alerts on re-audit.
// - EB-CHG-48V: certain suggestion for a codeless part — exercises the
//   provisional auto-select path.
// - EB-DSP-LCD: certain confirmation of the committed code — exercises
//   acknowledge.
// - EB-CTRL-V2: ambiguous, three candidates — exercises choosing.
export const STUB_SUGGESTIONS: Record<string, StoryEntry> = {
  "EB-BRK-HYD": {
    outcome: "certain",
    reasoning:
      "A hydraulic disc brake set sold as a complete assembly with calipers, levers, and hoses classifies as parts of bicycle brakes under 8714.94.9000, not the coaster-brake-adjacent 8714.94.3080 the catalog carries. Broker declarations on recent entries agree.",
    candidates: [
      {
        code: "8714.94.9000",
        confidence: 0.92,
        reason:
          "Complete hydraulic brake assemblies fall under 'parts of bicycle brakes, other' (10% general rate).",
      },
      {
        code: "8714.94.3080",
        confidence: 0.31,
        reason:
          "The current catalog code covers brakes other than coaster brakes; defensible only if imported as mounted brake units.",
      },
    ],
  },
  "EB-CHG-48V": {
    outcome: "certain",
    reasoning:
      "A 48V battery charger is a static converter (AC→DC rectifier) under 8504.40. The 9550 statistical suffix covers 'other' static converters.",
    candidates: [
      {
        code: "8504.40.9550",
        confidence: 0.9,
        reason: "Battery chargers are rectifying static converters.",
      },
    ],
  },
  "EB-DSP-LCD": {
    outcome: "certain",
    reasoning:
      "A backlit LCD display head unit is an indicator panel incorporating liquid crystal devices, squarely 8531.20.0040. The committed catalog code is correct.",
    candidates: [
      {
        code: "8531.20.0040",
        confidence: 0.97,
        reason:
          "Heading 8531.20 covers indicator panels incorporating LCDs by name.",
      },
    ],
  },
  "EB-CTRL-V2": {
    outcome: "ambiguous",
    reasoning:
      "A sine-wave motor controller could be a static converter (8504.40), a programmable control panel (8537.10), or an electronic assembly (8542.31) depending on whether the inverter function or the control function predominates. Needs a human call; a CROSS ruling on e-bike controllers would settle it.",
    candidates: [
      {
        code: "8537.10.9170",
        confidence: 0.48,
        reason:
          "Boards for electric control fitted with two or more apparatus of heading 8535/8536.",
      },
      {
        code: "8504.40.9550",
        confidence: 0.41,
        reason:
          "The current catalog code; defensible if the DC-AC inverter function predominates.",
      },
      {
        code: "8542.31.0001",
        confidence: 0.11,
        reason: "Only if imported as a bare processor module, which this is not.",
      },
    ],
  },
};

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function isProductCode(ref: HtsRef): boolean {
  return ref.chapter < 98;
}

export class StubClassifier implements Classifier {
  async classify(
    input: ClassifyInput,
    ref: ReferenceData,
  ): Promise<ClassifyResult> {
    const story = STUB_SUGGESTIONS[input.sku];
    if (story) {
      return {
        outcome: story.outcome,
        candidates: story.candidates.map((c) => {
          const digits = normalizeHts(c.code);
          return {
            code: c.code,
            codeDigits: digits,
            confidence: c.confidence,
            reason: c.reason,
          };
        }),
        reasoning: story.reasoning,
        classifier: "stub",
      };
    }

    // Fallback: rank schedule product codes sharing the current code's
    // first 6 (else first 4) digits, ordered by a SKU-seeded hash so the
    // choice is stable per part but varies across parts.
    if (input.currentHtsCode === null) {
      return {
        outcome: "none",
        candidates: [],
        reasoning: `No committed code to anchor on and no curated suggestion for ${input.sku}.`,
        classifier: "stub",
      };
    }

    const digits = normalizeHts(input.currentHtsCode);
    const seed = hashString(input.sku);
    const pool = [...ref.htsByDigits.values()].filter(isProductCode);
    let siblings = pool.filter(
      (h) => h.codeDigits.startsWith(digits.slice(0, 6)),
    );
    if (siblings.length === 0) {
      siblings = pool.filter((h) => h.codeDigits.startsWith(digits.slice(0, 4)));
    }
    siblings.sort(
      (a, b) =>
        hashString(`${seed}:${a.codeDigits}`) -
          hashString(`${seed}:${b.codeDigits}`) ||
        a.codeDigits.localeCompare(b.codeDigits),
    );

    const top = siblings.slice(0, 3);
    if (top.length === 0) {
      return {
        outcome: "none",
        candidates: [],
        reasoning: `No schedule rows near ${input.currentHtsCode} in the reference subset.`,
        classifier: "stub",
      };
    }

    const candidates: CandidateSuggestion[] = top.map((h, i) => ({
      code: h.code,
      codeDigits: h.codeDigits,
      confidence: Math.round((0.85 - i * 0.25 - (seed % 7) / 100) * 100) / 100,
      reason: h.description,
    }));

    return {
      outcome: top.length === 1 ? "certain" : "ambiguous",
      candidates,
      reasoning: `Ranked schedule neighbors of the current code ${input.currentHtsCode} for ${input.name}.`,
      classifier: "stub",
    };
  }
}
