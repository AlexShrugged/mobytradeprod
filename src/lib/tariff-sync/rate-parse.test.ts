import { describe, expect, it } from "vitest";

import { parseBaseRate, parseGeneralRate } from "./rate-parse";

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
