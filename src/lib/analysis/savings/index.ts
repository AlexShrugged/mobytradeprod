// Savings-analyst selection, mirroring ../index.ts: the real model when
// ANTHROPIC_API_KEY is set, the deterministic stub otherwise.
//
// Relative imports on purpose — this module runs under the tsx script.

import { isProdRuntime } from "../../env";
import { ClaudeSavingsAnalyst } from "./claude";
import type { SavingsAnalyst, SavingsResult } from "./types";

/** Keyless baseline: an empty report, honestly labeled. There is no
 *  deterministic way to imitate a classification review. */
export class StubSavingsAnalyst implements SavingsAnalyst {
  async analyze(): Promise<SavingsResult> {
    return {
      report: {
        summary:
          "No savings review ran. (Stub analyst — set ANTHROPIC_API_KEY for a real review.)",
        opportunities: [],
      },
      usage: {
        iterations: 0,
        inputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
      },
      trace: [],
      analyst: "stub",
      error: null,
    };
  }
}

export function getSavingsAnalyst(): SavingsAnalyst {
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeSavingsAnalyst();
  if (isProdRuntime()) {
    throw new Error(
      "ANTHROPIC_API_KEY is required on Vercel — refusing the stub savings analyst.",
    );
  }
  return new StubSavingsAnalyst();
}
