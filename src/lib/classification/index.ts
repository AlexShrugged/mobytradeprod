import { isProdRuntime } from "../env";
import { ClaudeClassifier } from "./claude-classifier";
import { StubClassifier } from "./stub-classifier";
import type { Classifier } from "./types";

// The classifier seam, mirroring getEntryAnalyst(): Claude when
// ANTHROPIC_API_KEY is set, the deterministic stub otherwise — and the stub
// is refused on Vercel (every stub fallback fails closed there). Callers
// see only the Classifier interface; suggestions always land in the review
// queue for a human to commit.
export function getClassifier(): Classifier {
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeClassifier();
  if (isProdRuntime()) {
    throw new Error(
      "ANTHROPIC_API_KEY is required on Vercel — refusing the stub classifier.",
    );
  }
  return new StubClassifier();
}
