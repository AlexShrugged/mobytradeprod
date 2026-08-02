import { StubClassifier } from "./stub-classifier";
import type { Classifier } from "./types";

// The classifier seam, mirroring getProcessor(): with ANTHROPIC_API_KEY set
// a Claude-backed classifier will slot in here; until it exists, everything
// downstream sees only the interface and the deterministic stub.
export function getClassifier(): Classifier {
  return new StubClassifier();
}
