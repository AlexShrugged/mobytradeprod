import { describe, expect, it } from "vitest";

import { describeDuplicate, summarizeDuplicates } from "./duplicates";

const existing = {
  id: "d1",
  fileName: "7077850722.pdf",
  uploadedAt: "2026-09-11T16:47:33.000Z",
};

describe("describeDuplicate", () => {
  it("names the document on file and when it arrived", () => {
    expect(describeDuplicate(existing)).toMatch(
      /^Identical to 7077850722\.pdf, uploaded /,
    );
  });
});

describe("summarizeDuplicates", () => {
  it("is empty for no duplicates", () => {
    expect(summarizeDuplicates([])).toBe("");
  });

  it("spells out a single skipped file", () => {
    const text = summarizeDuplicates([
      { index: 0, fileName: "7077850722.pdf", duplicateOf: existing },
    ]);
    expect(text).toMatch(
      /^Skipped 7077850722\.pdf: identical to 7077850722\.pdf, uploaded /,
    );
  });

  it("caps the list at three names", () => {
    const dups = ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"].map(
      (fileName, index) => ({ index, fileName, duplicateOf: existing }),
    );
    expect(summarizeDuplicates(dups)).toBe(
      "Skipped 5 duplicates already on file: a.pdf, b.pdf, c.pdf and 2 more.",
    );
  });
});
