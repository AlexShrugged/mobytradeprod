import { describe, expect, it } from "vitest";

import {
  PO_NUMBER_MAX,
  normalizeBol,
  splitPoReferences,
  splitReferenceNumbers,
} from "./normalize";

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

describe("splitPoReferences", () => {
  it("reads a space-separated list of orders and drops a trailing suffix", () => {
    expect(splitPoReferences("8121566 8122135 8122831 8123088 ATL")).toEqual([
      "8121566",
      "8122135",
      "8122831",
      "8123088",
    ]);
  });

  it("reads a slash-separated list, keeping a dashed order intact", () => {
    expect(
      splitPoReferences("8120346/8118676/8118476-1/8119753/8121086"),
    ).toEqual(["8120346", "8118676", "8118476-1", "8119753", "8121086"]);
  });

  it("keeps a single order that happens to contain a space or slash", () => {
    expect(splitPoReferences("PO 12345")).toEqual(["PO 12345"]);
    expect(splitPoReferences("12345/A")).toEqual(["12345/A"]);
    expect(splitPoReferences("8119907E7")).toEqual(["8119907E7"]);
  });

  it("still splits on commas and semicolons, deduplicated", () => {
    expect(splitPoReferences("8119907E7, 8119908E2;8119907E7")).toEqual([
      "8119907E7",
      "8119908E2",
    ]);
  });

  it("caps every result to the column width", () => {
    const long = "X".repeat(40);
    expect(splitPoReferences(long)).toEqual([long.slice(0, PO_NUMBER_MAX)]);
  });

  it("is empty for a blank input", () => {
    expect(splitPoReferences(null)).toEqual([]);
    expect(splitPoReferences("  ")).toEqual([]);
  });
});
