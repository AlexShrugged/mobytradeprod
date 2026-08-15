import { describe, expect, it } from "vitest";

import { fixtureRef as ref } from "../analysis/test-fixtures";
import {
  buildCandidatePool,
  ClaudeClassifier,
  type ClassifierClient,
} from "./claude-classifier";
import type { ClassifyInput } from "./types";

const input = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  sku: "EB-BAT-48V",
  name: "48V 14Ah Lithium Battery Pack",
  description: "Rechargeable lithium-ion battery pack",
  countriesOfOrigin: ["CN"],
  currentHtsCode: null,
  ...over,
});

function fakeClient(
  output: unknown,
  opts: { throws?: boolean; refusal?: boolean } = {},
): ClassifierClient {
  return {
    beta: {
      messages: {
        async parse() {
          if (opts.throws) throw new Error("boom");
          return {
            parsed_output: output,
            stop_reason: opts.refusal ? "refusal" : "end_turn",
          };
        },
      },
    },
  };
}

describe("buildCandidatePool", () => {
  it("matches schedule rows by product terms, product codes only", () => {
    const pool = buildCandidatePool(input(), ref);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.some((h) => /batter/i.test(h.description))).toBe(true);
    expect(pool.every((h) => h.chapter < 98)).toBe(true);
  });

  it("adds prefix neighbors of the current code", () => {
    const pool = buildCandidatePool(
      input({
        name: "Widget",
        description: null,
        currentHtsCode: "8501.31.4000",
      }),
      ref,
    );
    expect(pool.some((h) => h.codeDigits.startsWith("850131"))).toBe(true);
  });
});

describe("ClaudeClassifier", () => {
  it("keeps in-pool candidates and drops hallucinated codes", async () => {
    const pool = buildCandidatePool(input(), ref);
    const real = pool[0];
    const classifier = new ClaudeClassifier({
      client: fakeClient({
        outcome: "ambiguous",
        reasoning: "test",
        candidates: [
          { code: real.code, confidence: 1.4, reason: "fits" },
          { code: "9999.99.9999", confidence: 0.9, reason: "made up" },
        ],
      }),
    });
    const result = await classifier.classify(input(), ref);
    expect(result.classifier).toBe("claude");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].codeDigits).toBe(real.codeDigits);
    // Confidence clamped into 0..1.
    expect(result.candidates[0].confidence).toBe(1);
  });

  it("degrades outcome to none when every candidate was dropped", async () => {
    const classifier = new ClaudeClassifier({
      client: fakeClient({
        outcome: "certain",
        reasoning: "test",
        candidates: [{ code: "9999.99.9999", confidence: 0.9, reason: "x" }],
      }),
    });
    const result = await classifier.classify(input(), ref);
    expect(result.outcome).toBe("none");
    expect(result.candidates).toEqual([]);
  });

  it("falls back to the stub on failure, noting the error", async () => {
    const classifier = new ClaudeClassifier({
      client: fakeClient(null, { throws: true }),
    });
    const result = await classifier.classify(input(), ref);
    expect(result.classifier).toBe("stub");
    expect(result.reasoning).toContain("Claude classification failed");
  });

  it("treats a refusal as a failure path", async () => {
    const classifier = new ClaudeClassifier({
      client: fakeClient(null, { refusal: true }),
    });
    const result = await classifier.classify(input(), ref);
    expect(result.classifier).toBe("stub");
  });
});
