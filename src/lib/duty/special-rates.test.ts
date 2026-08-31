import { describe, expect, it } from "vitest";

import { parseSpecialRates, resolveSpiEligibility } from "./special-rates";

const KORUS_CELL =
  "Free (A*, AU, BH, CL, CO, D, E, IL, JO, KR, MA, OM, P, PA, PE, S, SG)";

describe("parseSpecialRates", () => {
  it("parses a single Free segment with its SPI list", () => {
    const segments = parseSpecialRates(KORUS_CELL);
    expect(segments).toHaveLength(1);
    expect(segments[0].rate).toBe(0);
    expect(segments[0].rateText).toBe("Free");
    expect(segments[0].spiCodes).toContain("KR");
    expect(segments[0].spiCodes).toContain("A*");
  });

  it("parses multi-segment cells with distinct rates", () => {
    const segments = parseSpecialRates(
      "Free (AU, BH, CL, KR, SG) 2.8% (JO)",
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].rate).toBe(0);
    expect(segments[1].rate).toBeCloseTo(0.028);
    expect(segments[1].spiCodes).toEqual(["JO"]);
  });

  it("keeps specific-rate segments with a null rate", () => {
    const segments = parseSpecialRates("0.51¢/kg (AU, KR)");
    expect(segments).toHaveLength(1);
    expect(segments[0].rate).toBeNull();
    expect(segments[0].rateText).toBe("0.51¢/kg");
  });

  it("drops parentheticals that are not SPI lists", () => {
    expect(parseSpecialRates("Free (see U.S. note 20 to this subchapter)")).toEqual(
      [],
    );
  });

  it("a rateless parenthetical inherits the previous segment's rate", () => {
    const segments = parseSpecialRates("Free (AU, BH) (KR)");
    expect(segments).toHaveLength(2);
    expect(segments[1].rate).toBe(0);
    expect(segments[1].spiCodes).toEqual(["KR"]);
  });

  it("null and blank cells parse to nothing", () => {
    expect(parseSpecialRates(null)).toEqual([]);
    expect(parseSpecialRates("")).toEqual([]);
  });
});

describe("resolveSpiEligibility", () => {
  it("a listed SPI is eligible at the segment's rate", () => {
    expect(resolveSpiEligibility(KORUS_CELL, "KR")).toEqual({
      status: "eligible",
      rate: 0,
      rateText: "Free",
    });
  });

  it("matching is case-insensitive and marker-insensitive", () => {
    expect(resolveSpiEligibility(KORUS_CELL, "kr").status).toBe("eligible");
    // Filed "A" claims the GSP family the schedule prints as "A*".
    expect(resolveSpiEligibility(KORUS_CELL, "A").status).toBe("eligible");
  });

  it("an SPI absent from a parsed cell is affirmatively ineligible", () => {
    expect(resolveSpiEligibility(KORUS_CELL, "CA")).toEqual({
      status: "ineligible",
    });
  });

  it("a percent special rate reports its decimal fraction", () => {
    expect(resolveSpiEligibility("2.8% (KR)", "KR")).toEqual({
      status: "eligible",
      rate: 0.028,
      rateText: "2.8%",
    });
  });

  it("a specific special rate is eligible but not computable", () => {
    expect(resolveSpiEligibility("0.51¢/kg (KR)", "KR")).toEqual({
      status: "eligible",
      rate: null,
      rateText: "0.51¢/kg",
    });
  });

  it("null, blank, or unparseable cells are unverifiable, never ineligible", () => {
    expect(resolveSpiEligibility(null, "KR")).toEqual({ status: "unverifiable" });
    expect(resolveSpiEligibility("", "KR")).toEqual({ status: "unverifiable" });
    expect(resolveSpiEligibility("Free (see note 20)", "KR")).toEqual({
      status: "unverifiable",
    });
  });
});
