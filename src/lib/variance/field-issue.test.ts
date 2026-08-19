import { describe, expect, it } from "vitest";

import { hasActionableDiff } from "./field-issue";

describe("hasActionableDiff", () => {
  it("admits a finding with a real expected value", () => {
    expect(
      hasActionableDiff([
        { field: "AD deposit", filed: "not declared", expected: "$2,572.50" },
      ]),
    ).toBe(true);
  });

  it("admits when any row has an expected value", () => {
    expect(
      hasActionableDiff([
        { field: "Case number", filed: "A-570-133", expected: null },
        { field: "AD deposit", filed: null, expected: "10%" },
      ]),
    ).toBe(true);
  });

  it("rejects a pure observation (empty fields)", () => {
    expect(hasActionableDiff([])).toBe(false);
  });

  it("rejects a single filed fact with no expectation", () => {
    expect(
      hasActionableDiff([
        { field: "Case number", filed: "A-570-133", expected: null },
      ]),
    ).toBe(false);
  });

  it("admits a filed-vs-filed disagreement (cross-entity split)", () => {
    expect(
      hasActionableDiff([
        { field: "This entry", filed: "9903.82.01 at $0", expected: null },
        {
          field: "Entry 231-0000002-2",
          filed: "9903.82.02 at $1,250.00",
          expected: null,
        },
      ]),
    ).toBe(true);
  });

  it("ignores blank filed values when counting the disagreement", () => {
    expect(
      hasActionableDiff([
        { field: "A", filed: "9903.82.01", expected: null },
        { field: "B", filed: "  ", expected: null },
        { field: "C", filed: null, expected: null },
      ]),
    ).toBe(false);
  });

  it("rejects blank or whitespace expected values", () => {
    expect(hasActionableDiff([{ field: "X", filed: "y", expected: "  " }])).toBe(
      false,
    );
  });

  it("rejects malformed jsonb shapes", () => {
    expect(hasActionableDiff(null)).toBe(false);
    expect(hasActionableDiff({ expected: "$5" })).toBe(false);
    expect(hasActionableDiff(["expected"])).toBe(false);
  });
});
