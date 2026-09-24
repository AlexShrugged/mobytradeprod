import { describe, expect, it } from "vitest";

import { HTS_CODE_MAX, canonicalHts, dottedHts } from "./hts-code";

describe("canonicalHts", () => {
  it("keeps the HTSUS print form as is", () => {
    expect(canonicalHts("8708.91.9900")).toEqual({
      code: "8708.91.9900",
      digits: "8708919900",
    });
  });

  it("closes a statistical suffix printed after a space (MotoRad's supplier)", () => {
    expect(canonicalHts("8708.91.99 00")).toEqual({
      code: "8708.91.9900",
      digits: "8708919900",
    });
    expect(canonicalHts("8301.20.02 01").code).toBe("8301.20.0201");
  });

  it("collapses a four-dotted print", () => {
    expect(canonicalHts("3923.50.01.00")).toEqual({
      code: "3923.50.0100",
      digits: "3923500100",
    });
    expect(canonicalHts("3926.90.99.99").code).toBe("3926.90.9999");
  });

  it("dots bare digits and keeps 6/8-digit HS headings short", () => {
    expect(canonicalHts("8708919900").code).toBe("8708.91.9900");
    expect(canonicalHts("870891")).toEqual({ code: "8708.91", digits: "870891" });
    expect(canonicalHts("87089199")).toEqual({
      code: "8708.91.99",
      digits: "87089199",
    });
    expect(canonicalHts(" 4016.93.5050 ").code).toBe("4016.93.5050");
  });

  it("keeps a list as printed with no comparison digits", () => {
    expect(canonicalHts("8481.80; 8708.91; 8708.99")).toEqual({
      code: "8481.80; 8708.91; 8708.99",
      digits: null,
    });
  });

  it("keeps a letter-prefixed or odd-length print as printed, uncompared", () => {
    expect(canonicalHts("S9032.10.0090")).toEqual({
      code: "S9032.10.0090",
      digits: null,
    });
    expect(canonicalHts("7307.19.03060")).toEqual({
      code: "7307.19.03060",
      digits: null,
    });
    expect(canonicalHts("HTS 8708.91.99").digits).toBeNull();
  });

  it("caps an overlong print to the column width", () => {
    const long = "8481.80; 8708.91; 8708.99; 3926.90; 3923.50; 8301.20";
    expect(canonicalHts(long).code).toBe(long.slice(0, HTS_CODE_MAX));
    expect(canonicalHts(long).code?.length).toBe(HTS_CODE_MAX);
  });

  it("is null for a blank input", () => {
    expect(canonicalHts(null)).toEqual({ code: null, digits: null });
    expect(canonicalHts(undefined)).toEqual({ code: null, digits: null });
    expect(canonicalHts("   ")).toEqual({ code: null, digits: null });
  });
});

describe("dottedHts", () => {
  it("formats 6, 8 and 10 digits the way the schedule prints them", () => {
    expect(dottedHts("870891")).toBe("8708.91");
    expect(dottedHts("87089199")).toBe("8708.91.99");
    expect(dottedHts("8708919900")).toBe("8708.91.9900");
  });
});
