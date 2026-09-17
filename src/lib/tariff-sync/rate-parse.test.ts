import { describe, expect, it } from "vitest";

import {
  parseBaseRate,
  parseColumnOneThreshold,
  parseGeneralRate,
} from "./rate-parse";

describe("parseGeneralRate", () => {
  it("parses the additional-duty idiom", () => {
    expect(
      parseGeneralRate("The duty provided in the applicable subheading + 25%"),
    ).toEqual({ kind: "additional", rate: 0.25 });
    expect(
      parseGeneralRate("The duty provided in the applicable subheading + 7.5%"),
    ).toEqual({ kind: "additional", rate: 0.075 });
  });

  it("a bare 'duty provided' with no surcharge is an exemption line", () => {
    expect(
      parseGeneralRate("The duty provided in the applicable subheading"),
    ).toEqual({ kind: "none" });
  });

  it("parses bare ad-valorem and none texts", () => {
    expect(parseGeneralRate("10%")).toEqual({ kind: "ad_valorem", rate: 0.1 });
    expect(parseGeneralRate("Free")).toEqual({ kind: "none" });
    expect(parseGeneralRate("No change")).toEqual({ kind: "none" });
    expect(parseGeneralRate("")).toEqual({ kind: "none" });
  });

  it("leaves compound/specific rates unparsed for the reviewer", () => {
    expect(parseGeneralRate("14.27¢/ liter")).toEqual({
      kind: "unparsed",
      text: "14.27¢/ liter",
    });
    expect(parseGeneralRate("2.5% + $0.50/kg")).toEqual({
      kind: "unparsed",
      text: "2.5% + $0.50/kg",
    });
  });
});

describe("parseBaseRate (base-schedule column 1 general)", () => {
  it("classifies Free and bare percentages as computable", () => {
    expect(parseBaseRate("Free")).toEqual({ rateType: "free", rate: 0 });
    expect(parseBaseRate("4.5%")).toEqual({ rateType: "ad_valorem", rate: 0.045 });
    expect(parseBaseRate("6.8%")).toEqual({ rateType: "ad_valorem", rate: 0.068 });
  });

  it("classifies specific and compound rates with rate null", () => {
    expect(parseBaseRate("14.27¢/liter")).toEqual({
      rateType: "specific",
      rate: null,
    });
    expect(parseBaseRate("$1.44/head")).toEqual({
      rateType: "specific",
      rate: null,
    });
    expect(parseBaseRate("4.4¢/kg + 3.2%")).toEqual({
      rateType: "compound",
      rate: null,
    });
  });

  it("anything else (prose, Ch99 idioms) is 'other' with rate null", () => {
    expect(parseBaseRate("The rate applicable to the article")).toEqual({
      rateType: "other",
      rate: null,
    });
    expect(
      parseBaseRate("The duty provided in the applicable subheading + 25%"),
    ).toEqual({ rateType: "other", rate: null });
  });
});

describe("rate idioms and the column-1 gate", () => {
  it("accepts the spelled-out plus of older additive headings", () => {
    expect(
      parseGeneralRate("The duty provided in the applicable subheading plus 25%"),
    ).toEqual({ kind: "additional", rate: 0.25 });
  });

  it("reads the ceiling threshold from the article text", () => {
    expect(
      parseColumnOneThreshold(
        "Except for products described in headings 9903.05.85–9903.05.92, articles the product of Taiwan, with an ad valorem (or ad valorem equivalent) rate of duty under column 1 less than 10 percent, as provided for in U.S. note 52 to this subchapter",
      ),
    ).toBe(0.1);
    expect(
      parseColumnOneThreshold(
        "Parts of passenger vehicles and light trucks that are products of Taiwan as provided for in subdivisions (g) and (u) of U.S. note 33 to this subchapter, with an ad valorem (or ad valorem equivalent as provided for in subdivision (m) of U.S. note 33 to this subchapter) rate of duty under column 1-General or column 1-Special less than 15 percent",
      ),
    ).toBe(0.15);
    expect(
      parseColumnOneThreshold(
        "articles the product of Japan, with an ad valorem rate of duty under column 1 less than 12.5 percent",
      ),
    ).toBe(0.125);
  });

  it("names no threshold for the at-or-above sibling or a clause-less heading", () => {
    expect(
      parseColumnOneThreshold(
        "articles the product of Taiwan, with an ad valorem (or ad valorem equivalent) rate of duty under column 1 equal to or greater than 10 percent",
      ),
    ).toBeNull();
    expect(
      parseColumnOneThreshold(
        "Wood products of Taiwan as provided for in subdivisions (d) and (f) of U.S. note 37 of this subchapter",
      ),
    ).toBeNull();
  });
});
