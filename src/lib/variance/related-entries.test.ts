import { describe, expect, it } from "vitest";

import {
  extractRelatedEntryNumbers,
  findingTexts,
  normalizeEntryNumber,
} from "./related-entries";

describe("extractRelatedEntryNumbers", () => {
  it("returns cited entries other than the finding's own, normalized", () => {
    expect(
      extractRelatedEntryNumbers(
        [
          "Two packet copies of sibling 7501 231-7354575-4 report different quantities",
          "231-7354576-2 line 1 pays 9903.82.02 while 231-7354574-7 claims the exclusion",
        ],
        "231-7354576-2",
      ),
    ).toEqual(["23173545754", "23173545747"]);
  });

  it("matches the own entry however it is hyphenated", () => {
    expect(
      extractRelatedEntryNumbers(["see 231-7354576-2"], "23173545762"),
    ).toEqual([]);
  });

  it("ignores bare digit runs like bills of lading", () => {
    expect(
      extractRelatedEntryNumbers(
        ['"bill_of_lading":"18061914941" on 231-7354575-4'],
        "231-0000000-0",
      ),
    ).toEqual(["23173545754"]);
  });

  it("dedupes repeats and skips empty text", () => {
    expect(
      extractRelatedEntryNumbers(
        ["231-7354575-4", null, "", "again 231-7354575-4"],
        "231-0000000-0",
      ),
    ).toEqual(["23173545754"]);
  });
});

describe("findingTexts", () => {
  it("collects every free-text surface and drops nulls", () => {
    expect(
      findingTexts({
        title: "t",
        explanation: "e",
        suggestedAction: "s",
        fields: [{ field: "f", filed: null, expected: "x" }],
        evidence: [{ quote: "q", statement: "st" }],
      }),
    ).toEqual(["t", "e", "s", "f", "x", "q", "st"]);
  });
});

describe("normalizeEntryNumber", () => {
  it("strips everything but digits", () => {
    expect(normalizeEntryNumber("231-7354575-4")).toBe("23173545754");
  });
});
