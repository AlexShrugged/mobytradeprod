// The org-rule blast radius, pure: each text axis resolving against the
// book, the capitalization / all-caps guards that keep prose from being
// read as a name, AND across axes, OR within one, the structured spec
// beside the text, and the fall-back to everything when nothing scopes.

import { describe, expect, it } from "vitest";

import { auditAlertType } from "../db/schema";
import type { SuppressionSpec } from "../org-rules";
import {
  entriesTouchedByRule,
  entriesTouchedByRules,
  extractRuleReferences,
  type RelevanceEntry,
  type RelevanceLine,
} from "./rule-relevance";

function line(over: Partial<RelevanceLine> = {}): RelevanceLine {
  return {
    supplierName: null,
    vendorName: null,
    countryOfOrigin: "CN",
    htsCodeDigits: "8714100050",
    chargeHtsDigits: [],
    skus: [],
    ...over,
  };
}

function entry(
  entryId: string,
  entryNumber: string,
  lines: RelevanceLine[],
): RelevanceEntry {
  return { entryId, entryNumber, lines };
}

// A small book: two Shenzhen Foo entries (CN and VN), a Taiwanese Giant
// entry under a different heading, and an Acme entry from Vietnam with a
// numeric SKU and a word-like SKU.
const book: RelevanceEntry[] = [
  entry("e1", "231-7354574-7", [
    line({
      supplierName: "SHENZHEN FOO TECHNOLOGY CO., LTD.",
      skus: ["EB-500"],
      chargeHtsDigits: ["99038201"],
    }),
  ]),
  entry("e2", "231-7376568-3", [
    line({
      supplierName: "Giant Manufacturing Co Ltd",
      countryOfOrigin: "TW",
      htsCodeDigits: "8712004800",
      skus: ["FRAME-01"],
    }),
  ]),
  entry("e3", "231-7377083-2", [
    line({
      supplierName: "ACME INDUSTRIES INC",
      vendorName: "Acme Industries",
      countryOfOrigin: "VN",
      htsCodeDigits: "8501314000",
      skus: ["12345", "BOLT"],
    }),
  ]),
  entry("e4", "231-7400000-1", [
    line({
      supplierName: "SHENZHEN FOO TECHNOLOGY CO., LTD.",
      countryOfOrigin: "VN",
    }),
  ]),
];

const spec = (over: Partial<SuppressionSpec> = {}): SuppressionSpec => ({
  alertTypes: [auditAlertType.enumValues[0]],
  supplierName: null,
  countryOfOrigin: null,
  htsPrefix: null,
  ...over,
});

const reach = (text: string, suppression: SuppressionSpec | null = null) =>
  entriesTouchedByRule({ text, suppression }, book);

const ids = (text: string, suppression: SuppressionSpec | null = null) => {
  const r = reach(text, suppression);
  if (r.all) throw new Error("expected a scoped reach");
  return [...r.entryIds].sort();
};

describe("HTS references", () => {
  it("a dotted code resolves against line headings", () => {
    expect(extractRuleReferences("Ignore HTS mismatches on 8714.10", book))
      .toMatchObject({ htsPrefixes: ["871410"] });
    expect(ids("Ignore HTS mismatches on 8714.10")).toEqual(["e1", "e4"]);
  });

  it("a Chapter 99 code resolves against charge headings", () => {
    expect(ids("Our 9903.82.01 no-content exclusion claims are legitimate"))
      .toEqual(["e1"]);
  });

  it("a labeled bare digit run is a code", () => {
    expect(ids("Frames are correctly classified under 8712004800")).toEqual([
      "e2",
    ]);
    expect(ids("HTS 8501.31 covers these motors")).toEqual(["e3"]);
  });

  it("a code nothing declares is noise, not an empty scope", () => {
    expect(reach("Since 2025.01 the broker files everything correctly"))
      .toEqual({ all: true });
    expect(extractRuleReferences("Since 2025.01 ...", book).htsPrefixes)
      .toEqual([]);
  });

  it("an unlabeled bare number is never a code", () => {
    expect(reach("Shipments over 8714100050 units are fine")).toEqual({
      all: true,
    });
  });
});

describe("country references", () => {
  it("resolves the region name, a demonym, and the bare code", () => {
    expect(ids("Vietnam origin is declared correctly")).toEqual(["e3", "e4"]);
    expect(ids("Vietnamese goods are fine")).toEqual(["e3", "e4"]);
    expect(ids("COO VN is right for these")).toEqual(["e3", "e4"]);
    expect(ids("Taiwanese frames carry the right COO")).toEqual(["e2"]);
  });

  it("only countries the book declares are candidates", () => {
    expect(reach("Goods from Mexico are exempt")).toEqual({ all: true });
  });

  it("a single-word name must be capitalized", () => {
    expect(reach("vietnam origin is declared correctly")).toEqual({
      all: true,
    });
  });

  it("a bare code that is also an English word never matches", () => {
    const withIndia: RelevanceEntry[] = [
      ...book,
      entry("e5", "231-7500000-0", [line({ countryOfOrigin: "IN" })]),
    ];
    expect(entriesTouchedByRule({ text: "Everything IN scope", suppression: null }, withIndia))
      .toEqual({ all: true });
    const named = entriesTouchedByRule(
      { text: "India origin is correct", suppression: null },
      withIndia,
    );
    expect(named).toEqual({ all: false, entryIds: ["e5"] });
  });
});

describe("supplier references", () => {
  it("matches the leading words of a suffixed corporate name", () => {
    expect(ids("Shenzhen Foo declares COO correctly")).toEqual(["e1", "e4"]);
    expect(ids("Shenzhen Foo Technology is a trusted supplier")).toEqual([
      "e1",
      "e4",
    ]);
  });

  it("matches a single-word name only when capitalized", () => {
    expect(ids("Giant frames are always classified right")).toEqual(["e2"]);
    expect(reach("giant shipments are always fine")).toEqual({ all: true });
  });

  it("resolves through the vendor name too", () => {
    expect(ids("Acme rebates are not part of transaction value")).toEqual([
      "e3",
    ]);
  });
});

describe("SKU references", () => {
  it("matches a SKU token with punctuation intact", () => {
    expect(ids("EB-500 is classified correctly.")).toEqual(["e1"]);
    expect(ids("Part FRAME-01, always 8712")).toEqual(["e2"]);
  });

  it("matches a numeric SKU only at five digits or more", () => {
    expect(ids("SKU 12345 is a known part")).toEqual(["e3"]);
    const short: RelevanceEntry[] = [
      entry("s1", "231-7600000-0", [line({ skus: ["1234"] })]),
    ];
    expect(entriesTouchedByRule({ text: "SKU 1234 is fine", suppression: null }, short))
      .toEqual({ all: true });
  });

  it("matches a pure-alpha SKU only in all caps", () => {
    expect(ids("BOLT ships from Vietnam")).toEqual(["e3"]);
    expect(reach("Every bolt ships duty-free")).toEqual({ all: true });
  });
});

describe("entry number references", () => {
  it("matches with or without hyphens", () => {
    expect(ids("Entry 231-7354574-7 was reviewed by hand")).toEqual(["e1"]);
    expect(ids("Entry 23173545747 was reviewed by hand")).toEqual(["e1"]);
  });

  it("an unknown entry number scopes nothing", () => {
    expect(reach("Entry 999-9999999-9 was reviewed")).toEqual({ all: true });
  });
});

describe("composition", () => {
  it("axes AND together", () => {
    expect(ids("Shenzhen Foo goods from Vietnam are declared right")).toEqual([
      "e4",
    ]);
    expect(ids("Entry 231-7354574-7 from Vietnam")).toEqual([]);
  });

  it("values within an axis OR", () => {
    expect(ids("Vietnam and Taiwan origins are both correct")).toEqual([
      "e2",
      "e3",
      "e4",
    ]);
  });

  it("the structured spec filters per line beside the text", () => {
    expect(ids("Vietnam shipments", spec({ htsPrefix: "8714" }))).toEqual([
      "e4",
    ]);
    expect(ids("No references here", spec({ supplierName: "acme industries inc" })))
      .toEqual(["e3"]);
  });

  it("nothing scoping means everything", () => {
    expect(reach("Always trust the broker's MPF")).toEqual({ all: true });
    expect(reach("Always trust the broker's MPF", spec())).toEqual({
      all: true,
    });
  });
});

describe("entriesTouchedByRules", () => {
  it("unions the states and widens on any unscoped one", () => {
    expect(
      entriesTouchedByRules(
        [
          { text: "Giant frames", suppression: null },
          { text: "EB-500 is fine", suppression: null },
        ],
        book,
      ),
    ).toEqual({ all: false, entryIds: ["e2", "e1"] });
    expect(
      entriesTouchedByRules(
        [
          { text: "Giant frames", suppression: null },
          { text: "Trust the broker", suppression: null },
        ],
        book,
      ),
    ).toEqual({ all: true });
    expect(entriesTouchedByRules([], book)).toEqual({ all: false, entryIds: [] });
  });
});
