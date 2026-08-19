import { describe, expect, it } from "vitest";

import { normalizeBol, splitReferenceNumbers } from "./normalize";

describe("normalizeBol", () => {
  it("strips separators and uppercases", () => {
    expect(normalizeBol("180-61914941")).toBe("18061914941");
    expect(normalizeBol("18061914941")).toBe("18061914941");
    expect(normalizeBol("maeu 216455870")).toBe("MAEU216455870");
  });

  it("dash and no-dash AWB spellings collide", () => {
    expect(normalizeBol("180-61914941")).toBe(normalizeBol("18061914941"));
  });
});

describe("splitReferenceNumbers", () => {
  it("passes a single number through", () => {
    expect(splitReferenceNumbers("8119907E7")).toEqual(["8119907E7"]);
  });

  it("splits comma-joined numbers", () => {
    expect(splitReferenceNumbers("8119907E7,8119908E2")).toEqual([
      "8119907E7",
      "8119908E2",
    ]);
  });

  it("splits on semicolons and newlines, trims, dedupes", () => {
    expect(splitReferenceNumbers(" 8119907E7 ; 8119908E2\n8119907E7,")).toEqual(
      ["8119907E7", "8119908E2"],
    );
  });

  it("never splits on spaces or slashes inside a number", () => {
    expect(splitReferenceNumbers("PO 4500123/01")).toEqual(["PO 4500123/01"]);
  });

  it("handles null and empty", () => {
    expect(splitReferenceNumbers(null)).toEqual([]);
    expect(splitReferenceNumbers("")).toEqual([]);
  });
});
