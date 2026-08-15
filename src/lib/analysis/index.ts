// Analyst selection, mirroring tariff-sync/extractor/index.ts: the real
// model when ANTHROPIC_API_KEY is set, the deterministic stub otherwise —
// callers see only the EntryAnalyst interface.
//
// Relative imports on purpose — this module runs under the tsx eval script.

import { isProdRuntime } from "../env";

import { ClaudeEntryAnalyst } from "./claude";
import { StubEntryAnalyst } from "./stub";
import type { EntryAnalyst } from "./types";

// On Vercel the stub is refused: it merely echoes deterministic findings
// while presenting as "analysis" — an empty imitation in a paid product is
// worse than an explicit configuration failure.
export function getEntryAnalyst(): EntryAnalyst {
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeEntryAnalyst();
  if (isProdRuntime()) {
    throw new Error(
      "ANTHROPIC_API_KEY is required on Vercel — refusing the stub entry analyst.",
    );
  }
  return new StubEntryAnalyst();
}
