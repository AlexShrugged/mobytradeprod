import { describe, expect, it } from "vitest";

import {
  countriesLabel,
  coverageLabel,
  diffRevisionFields,
  rateLabel,
} from "./revision-diff";
import type { LiveMeasureSnapshot, ProposedMeasureChange } from "./types";

const live = (over: Partial<LiveMeasureSnapshot> = {}): LiveMeasureSnapshot => ({
  measureId: "m1",
  ch99Code: "9903.88.01",
  ch99Digits: "99038801",
  name: "Section 301 List 1",
  authority: "section_301",
  scope: "hts_list",
  countries: ["CN"],
  countriesExcluded: null,
  effectiveDate: "2018-07-06",
  endDate: null,
  sailedOnOrAfter: null,
  sailedOnOrBefore: null,
  rate: 0.25,
  rateType: "ad_valorem",
  rateText: null,
  exemption: false,
  description: "Articles of China subject to Section 301 List 1",
  prefixes: ["8501", "8507"],
  ...over,
});

const proposed = (
  over: Partial<ProposedMeasureChange> = {},
): ProposedMeasureChange => ({
  name: "Section 301 List 1",
  authority: "section_301",
  scope: "hts_list",
  countries: ["CN"],
  countriesExcluded: null,
  effectiveDate: null,
  endDate: null,
  sailedOnOrAfter: null,
  sailedOnOrBefore: null,
  rate: 0.25,
  rateType: "ad_valorem",
  rateText: null,
  exemption: false,
  inLieuOfBaseDuty: false,
  prefixes: ["8501", "8507"],
  notes: null,
  ...over,
});

describe("labels", () => {
  it("rateLabel handles ad-valorem, exempt, and raw-text rates", () => {
    expect(rateLabel({ rate: 0.075, exemption: false })).toBe("7.5%");
    expect(rateLabel({ rate: 0, exemption: true })).toBe("exempt");
    expect(rateLabel({ rate: null, rateText: "$80/net ton", exemption: false })).toBe(
      "$80/net ton",
    );
  });

  it("countriesLabel handles inclusion, exclusion, and all", () => {
    expect(countriesLabel({ countries: ["CN", "HK"] })).toBe("CN, HK");
    expect(countriesLabel({ countries: null })).toBe("all countries");
    expect(
      countriesLabel({ countries: null, countriesExcluded: ["CA", "MX"] }),
    ).toBe("all except CA, MX");
  });

  it("coverageLabel counts prefixes", () => {
    expect(coverageLabel({ scope: "all_products", prefixes: [] })).toBe(
      "all products",
    );
    expect(coverageLabel({ scope: "hts_list", prefixes: ["8501"] })).toBe(
      "1 HTS prefix",
    );
  });
});

describe("diffRevisionFields", () => {
  it("returns nothing for a create (no live side)", () => {
    expect(diffRevisionFields(null, proposed())).toEqual([]);
  });

  it("returns nothing when nothing material changed", () => {
    expect(diffRevisionFields(live(), proposed())).toEqual([]);
  });

  it("diffs only the fields that changed", () => {
    const rows = diffRevisionFields(
      live(),
      proposed({ rate: 0.5, countries: ["CN", "HK"] }),
    );
    expect(rows).toEqual([
      { field: "Rate", live: "25%", proposed: "50%" },
      { field: "Countries", live: "CN", proposed: "CN, HK" },
    ]);
  });

  it("shows a source-text diff when the prose moved", () => {
    const rows = diffRevisionFields(
      live(),
      proposed(),
      "Articles of China and Hong Kong subject to Section 301 List 1",
    );
    expect(rows).toEqual([
      {
        field: "Source text",
        live: "Articles of China subject to Section 301 List 1",
        proposed: "Articles of China and Hong Kong subject to Section 301 List 1",
      },
    ]);
  });

  it("diffs an ad-valorem → specific rate change through the raw text", () => {
    const rows = diffRevisionFields(
      live(),
      proposed({ rate: null, rateType: "specific", rateText: "$80/net ton" }),
    );
    expect(rows).toEqual([
      { field: "Rate", live: "25%", proposed: "$80/net ton" },
    ]);
  });
});
