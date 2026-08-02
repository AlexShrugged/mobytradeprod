import { describe, expect, it } from "vitest";

import {
  applyReviewAction,
  deriveInitialReview,
  type ReviewState,
} from "./review";
import type { ClassifyResult } from "./types";

function state(over: Partial<ReviewState> = {}): ReviewState {
  return { partStatus: "pending", provisional: false, kind: "suggestion", ...over };
}

function result(over: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    outcome: "certain",
    candidates: [
      {
        code: "8714.94.9000",
        codeDigits: "8714949000",
        confidence: 0.9,
        reason: "r",
      },
    ],
    reasoning: "because",
    classifier: "stub",
    ...over,
  };
}

describe("applyReviewAction", () => {
  it("accept commits the code and approves the item", () => {
    const effect = applyReviewAction(state(), {
      action: "accept",
      code: "8714.94.9000",
    });
    expect(effect).toEqual({
      nextPartStatus: "accepted",
      nextItemStatus: "approved",
      commitCode: "8714.94.9000",
      clearProvisional: false,
    });
  });

  it("manual commits on both suggestions and confirmations", () => {
    for (const kind of ["suggestion", "confirmation"] as const) {
      const effect = applyReviewAction(
        state({ kind, partStatus: kind === "confirmation" ? "confirmed" : "pending" }),
        { action: "manual", code: "8501.31.4000" },
      );
      expect(effect.commitCode).toBe("8501.31.4000");
      expect(effect.nextPartStatus).toBe("accepted");
    }
  });

  it("acknowledge applies only to open confirmations", () => {
    const effect = applyReviewAction(
      state({ kind: "confirmation", partStatus: "confirmed" }),
      { action: "acknowledge" },
    );
    expect(effect.nextPartStatus).toBe("acknowledged");
    expect(effect.commitCode).toBeNull();

    expect(() =>
      applyReviewAction(state(), { action: "acknowledge" }),
    ).toThrow(/acknowledge applies to open confirmations/);
  });

  it("soft-reject clears only provisional auto-selects", () => {
    const provisional = applyReviewAction(state({ provisional: true }), {
      action: "reject",
    });
    expect(provisional.clearProvisional).toBe(true);
    expect(provisional.nextItemStatus).toBe("rejected");

    const committed = applyReviewAction(state({ provisional: false }), {
      action: "reject",
    });
    expect(committed.clearProvisional).toBe(false);
  });

  it("reject is illegal on confirmations", () => {
    expect(() =>
      applyReviewAction(state({ kind: "confirmation", partStatus: "confirmed" }), {
        action: "reject",
      }),
    ).toThrow(/Cannot reject/);
  });

  it("reopen returns a rejected item to its open status", () => {
    const suggestion = applyReviewAction(state({ partStatus: "rejected" }), {
      action: "reopen",
    });
    expect(suggestion.nextPartStatus).toBe("pending");
    expect(suggestion.nextItemStatus).toBe("pending");

    const confirmation = applyReviewAction(
      state({ partStatus: "rejected", kind: "confirmation" }),
      { action: "reopen" },
    );
    expect(confirmation.nextPartStatus).toBe("confirmed");
  });

  it("reopen from decided statuses throws (re-classification supersedes)", () => {
    for (const partStatus of ["accepted", "acknowledged"] as const) {
      expect(() =>
        applyReviewAction(state({ partStatus }), { action: "reopen" }),
      ).toThrow(/Cannot reopen/);
    }
  });

  it("accepting on a decided item throws", () => {
    expect(() =>
      applyReviewAction(state({ partStatus: "accepted" }), {
        action: "accept",
        code: "8714.94.9000",
      }),
    ).toThrow(/Cannot accept/);
  });

  it("rejects malformed and chapter-99 commit codes", () => {
    expect(() =>
      applyReviewAction(state(), { action: "manual", code: "invalid" }),
    ).toThrow(/expected 8 or 10 digits/);
    expect(() =>
      applyReviewAction(state(), { action: "manual", code: "9903.88.01" }),
    ).toThrow(/expected 8 or 10 digits|chapter 98\/99/);
    expect(() =>
      applyReviewAction(state(), { action: "manual", code: "9903.88.0155" }),
    ).toThrow(/chapter 98\/99/);
  });
});

describe("deriveInitialReview", () => {
  it("outcome none or empty candidates produce no review item", () => {
    expect(deriveInitialReview(result({ outcome: "none", candidates: [] }), null)).toBeNull();
    expect(deriveInitialReview(result({ candidates: [] }), null)).toBeNull();
  });

  it("certain match of the committed code is a confirmation", () => {
    const initial = deriveInitialReview(result(), "8714949000");
    expect(initial).toEqual({
      kind: "confirmation",
      partStatus: "confirmed",
      autoSelectProvisional: false,
    });
  });

  it("a differing suggestion stays a suggestion, never auto-selected over a committed code", () => {
    const initial = deriveInitialReview(result(), "8714943080");
    expect(initial).toEqual({
      kind: "suggestion",
      partStatus: "pending",
      autoSelectProvisional: false,
    });
  });

  it("certain suggestion for a codeless part auto-selects provisionally", () => {
    const initial = deriveInitialReview(result(), null);
    expect(initial?.autoSelectProvisional).toBe(true);
  });

  it("ambiguous results never auto-select and never confirm", () => {
    const ambiguous = result({ outcome: "ambiguous" });
    expect(deriveInitialReview(ambiguous, null)?.autoSelectProvisional).toBe(false);
    // Even when the primary matches the committed code, ambiguity needs eyes.
    expect(deriveInitialReview(ambiguous, "8714949000")?.kind).toBe("suggestion");
  });
});
