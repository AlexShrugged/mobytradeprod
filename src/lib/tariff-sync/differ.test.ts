import { describe, expect, it } from "vitest";

import { classifyAuthority, contentHashOf, detectCountries, diffRelease } from "./differ";
import { parseCh99Rows } from "./usitc";
import type {
  Ch99Row,
  LiveMeasureSnapshot,
  OpenRevisionRef,
  TariffSyncState,
} from "./types";

function row(over: Partial<Ch99Row> & { htsno: string }): Ch99Row {
  return {
    digits: over.htsno.replace(/\D/g, ""),
    description: "Articles subject to a trade measure",
    general: "The duty provided in the applicable subheading + 25%",
    special: "No change",
    additionalDuties: "",
    footnotes: "",
    ...over,
  };
}

function live(over: Partial<LiveMeasureSnapshot> = {}): LiveMeasureSnapshot {
  return {
    measureId: "m1",
    ch99Code: "9903.88.01",
    ch99Digits: "99038801",
    name: "Section 301 List 1 — China",
    authority: "section_301",
    scope: "hts_list",
    countries: ["CN"],
    effectiveDate: "2018-07-06",
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    rate: 0.25,
    exemption: false,
    description: "Articles of China subject to Section 301 List 1 (25%)",
    prefixes: ["8501"],
    ...over,
  };
}

const stateWith = (...snaps: LiveMeasureSnapshot[]): TariffSyncState => ({
  byDigits: new Map(snaps.map((s) => [s.ch99Digits, s])),
});

describe("diffRelease classification", () => {
  it("unknown code -> create_measure with parsed rate, authority, countries", () => {
    const r = row({
      htsno: "9903.99.11",
      description:
        "Articles the product of China subject to Section 301 remedies (30%)",
      general: "The duty provided in the applicable subheading + 30%",
    });
    const { revisions } = diffRelease([r], stateWith(), []);
    expect(revisions).toHaveLength(1);
    const rev = revisions[0];
    expect(rev.changeType).toBe("create_measure");
    expect(rev.authority).toBe("section_301");
    expect(rev.proposed.rate).toBe(0.3);
    expect(rev.proposed.countries).toEqual(["CN"]);
    // Dates are never auto-filled — reviewer territory.
    expect(rev.proposed.effectiveDate).toBeNull();
    expect(rev.proposed.sailedOnOrBefore).toBeNull();
  });

  it("bare 'duty provided' line stages as an exemption candidate", () => {
    const r = row({
      htsno: "9903.01.23",
      general: "The duty provided in the applicable subheading",
    });
    const { revisions } = diffRelease([r], stateWith(), []);
    expect(revisions[0].proposed.exemption).toBe(true);
    expect(revisions[0].proposed.rate).toBe(0);
  });

  it("known code with a new rate -> rate_change targeting the live measure", () => {
    const r = row({
      htsno: "9903.88.01",
      description: "Articles of China subject to Section 301 List 1 (25%)",
      general: "The duty provided in the applicable subheading + 30%",
    });
    const { revisions } = diffRelease([r], stateWith(live()), []);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].changeType).toBe("rate_change");
    expect(revisions[0].targetMeasureId).toBe("m1");
    expect(revisions[0].proposed.rate).toBe(0.3);
    expect(revisions[0].liveSnapshot?.rate).toBe(0.25);
  });

  it("description-only drift -> note_change; identical row -> nothing", () => {
    const changed = row({
      htsno: "9903.88.01",
      description: "Articles of China subject to Section 301 List 1 (updated)",
    });
    const { revisions } = diffRelease([changed], stateWith(live()), []);
    expect(revisions.map((r) => r.changeType)).toEqual(["note_change"]);

    const identical = row({
      htsno: "9903.88.01",
      description: "Articles of China subject to Section 301 List 1 (25%)",
    });
    expect(diffRelease([identical], stateWith(live()), []).revisions).toEqual([]);
  });

  it("live code absent from the release -> end_measure", () => {
    const { revisions } = diffRelease([], stateWith(live()), []);
    expect(revisions.map((r) => r.changeType)).toEqual(["end_measure"]);
    expect(revisions[0].proposed.endDate).toBeNull(); // reviewer sets it
  });

  it("create_measure proposals carry the inferred program", () => {
    const reciprocal = row({
      htsno: "9903.02.05",
      description: "Articles the product of Brazil (reciprocal tariff, 10%)",
      general: "The duty provided in the applicable subheading + 10%",
    });
    const unknown = row({
      htsno: "9903.99.11",
      description: "Articles subject to additional duties",
    });
    const { revisions } = diffRelease([reciprocal, unknown], stateWith(), []);
    const byCode = new Map(revisions.map((r) => [r.ch99Code, r]));
    expect(byCode.get("9903.02.05")?.proposed.program).toBe("ieepa-reciprocal");
    // Not confident -> explicit null, never a guess.
    expect(byCode.get("9903.99.11")?.proposed.program).toBeNull();
  });

  it("change and end revisions carry the live measure's program forward", () => {
    const tracked = live({ program: "section-301-china" });
    const rateBump = row({
      htsno: "9903.88.01",
      description: "Articles of China subject to Section 301 List 1 (25%)",
      general: "The duty provided in the applicable subheading + 30%",
    });
    const changed = diffRelease([rateBump], stateWith(tracked), []);
    expect(changed.revisions[0].proposed.program).toBe("section-301-china");

    const ended = diffRelease([], stateWith(tracked), []);
    expect(ended.revisions[0].proposed.program).toBe("section-301-china");
  });

  it("statistical suffixes and non-9903 rows are ignored", () => {
    const rows = parseCh99Rows([
      { htsno: "9903.88.01.15", description: "stat line", general: "" },
      { htsno: "9901.00.50", description: "ethanol", general: "" },
      { htsno: "9903.88", description: "heading", general: "" },
      {
        htsno: "9903.77.77",
        description: "A brand new measure line",
        general: "The duty provided in the applicable subheading + 5%",
      },
    ]);
    expect(rows.map((r) => r.htsno)).toEqual(["9903.77.77"]);
  });
});

describe("stageNewCodes option (partial reference subset)", () => {
  it("untracked codes are counted, not staged, when disabled", () => {
    const unknown = row({ htsno: "9903.99.11" });
    const tracked = row({
      htsno: "9903.88.01",
      general: "The duty provided in the applicable subheading + 30%",
    });
    const result = diffRelease([unknown, tracked], stateWith(live()), [], {
      stageNewCodes: false,
    });
    expect(result.untrackedCodes).toBe(1);
    expect(result.revisions.map((r) => r.changeType)).toEqual(["rate_change"]);
  });
});

describe("hash dedupe and supersession", () => {
  const releaseRow = row({
    htsno: "9903.88.01",
    general: "The duty provided in the applicable subheading + 30%",
  });

  const openFor = (hash: string): OpenRevisionRef => ({
    revisionId: "rev1",
    reviewItemId: "item1",
    announcementId: "ann1",
    ch99Digits: "99038801",
    contentHash: hash,
  });

  it("an open revision with the same content hash suppresses re-staging", () => {
    const open = openFor(contentHashOf(releaseRow));
    const { revisions, superseded } = diffRelease(
      [releaseRow],
      stateWith(live()),
      [open],
    );
    expect(revisions).toEqual([]);
    expect(superseded).toEqual([]);
  });

  it("changed content supersedes the stale open revision and re-stages", () => {
    const open = openFor("0".repeat(64));
    const { revisions, superseded } = diffRelease(
      [releaseRow],
      stateWith(live()),
      [open],
    );
    expect(revisions).toHaveLength(1);
    expect(superseded.map((s) => s.reviewItemId)).toEqual(["item1"]);
  });
});

describe("detectCountries", () => {
  it("maps 'product of' phrasing to ISO codes", () => {
    expect(
      detectCountries("articles the product of China and Hong Kong that were"),
    ).toEqual(["CN", "HK"]);
    expect(detectCountries("articles of aluminum")).toBeNull();
  });
});

describe("classifyAuthority — Section 232 product actions and Section 338", () => {
  const cases: [string, string, string][] = [
    // [description, htsno, expected]
    ["Section 232 tariff on semi-finished copper products", "9903.78.01", "section_232_copper"],
    ["Section 232 tariffs on auto parts (25%)", "9903.94.05", "section_232_autos"],
    ["Section 232 tariff on passenger vehicles and light trucks", "9903.91.01", "section_232_autos"],
    ["Section 232 timber: softwood timber and lumber", "9903.76.01", "section_232_timber_furniture"],
    ["10% tariff on softwood timber and lumber imports", "9903.96.01", "section_232_timber_furniture"],
    ["25% tariff on certain upholstered furniture", "9903.96.02", "section_232_timber_furniture"],
    ["100% tariff on branded or patented pharmaceutical products", "9903.95.01", "section_232_pharma"],
    ["Tariff Act of 1930 Section 338 duties on certain products", "9903.03.14", "section_338"],
    // Combined metals actions keep their historical aluminum bucketing.
    ["Section 232 tariff on articles of aluminum, steel, or copper", "9903.82.02", "section_232_aluminum"],
    // Prefix-only fallback (USITC prose without keyword cues).
    ["Articles subject to additional duties", "9903.78.05", "section_232_copper"],
    ["Articles subject to additional duties", "9903.94.10", "section_232_autos"],
    ["Articles subject to additional duties", "9903.95.02", "section_232_pharma"],
  ];

  for (const [description, htsno, expected] of cases) {
    it(`"${description.slice(0, 48)}…" (${htsno}) → ${expected}`, () => {
      expect(classifyAuthority(description, htsno)).toBe(expected);
    });
  }
});

describe("non-ad-valorem rate classification in the differ", () => {
  it("carries the raw text and classified type for unparsed rates", () => {
    const { revisions } = diffRelease(
      [
        row({
          htsno: "9903.99.05",
          description: "Port maintenance fee on certain vessels",
          general: "$80/net ton",
        }),
      ],
      { byDigits: new Map() },
      [],
      { stageNewCodes: true },
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0].proposed.rate).toBeNull();
    expect(revisions[0].proposed.rateType).toBe("specific");
    expect(revisions[0].proposed.rateText).toBe("$80/net ton");
  });

  it("plain ad-valorem rates stay numeric with no raw text", () => {
    const { revisions } = diffRelease(
      [row({ htsno: "9903.99.06" })],
      { byDigits: new Map() },
      [],
      { stageNewCodes: true },
    );
    expect(revisions[0].proposed.rate).toBe(0.25);
    expect(revisions[0].proposed.rateType).toBe("ad_valorem");
    expect(revisions[0].proposed.rateText).toBeNull();
  });
});

describe("detectCountries — reciprocal annex coverage", () => {
  it("resolves the smaller annex countries", () => {
    expect(
      detectCountries("articles the product of Thailand, as provided for…"),
    ).toEqual(["TH"]);
    expect(
      detectCountries("articles the product of Papua New Guinea, as provided…"),
    ).toEqual(["PG"]);
  });

  it("handles the USITC curly apostrophe in Côte d'Ivoire", () => {
    expect(
      detectCountries("articles the product of Côte d’Ivoire, as provided…"),
    ).toEqual(["CI"]);
  });

  it("expands the European Union to member-state codes", () => {
    const codes = detectCountries("articles the product of the European Union");
    expect(codes).toContain("DE");
    expect(codes).toContain("FR");
    expect(codes).toHaveLength(27);
  });

  it("still collects multiple named countries", () => {
    expect(
      detectCountries("articles the product of China and Hong Kong"),
    ).toEqual(expect.arrayContaining(["CN", "HK"]));
  });
});

describe("classifyAuthority — reciprocal country headings by prefix", () => {
  it("9903.02.xx prose names only the country; the prefix says reciprocal", () => {
    expect(
      classifyAuthority(
        "Except for goods loaded onto a vessel …, articles the product of India, as provided for in subdivision (v)",
        "9903.02.26",
      ),
    ).toBe("reciprocal");
  });
});

describe("classifyAuthority — prefix beats weak product cues", () => {
  it("a reciprocal country heading mentioning pharmaceutical products stays reciprocal", () => {
    expect(
      classifyAuthority(
        "Articles the product of Switzerland that are non-patented articles for use in pharmaceutical applications",
        "9903.02.86",
      ),
    ).toBe("reciprocal");
  });

  it("statute keywords still beat prefixes (chapters get re-purposed)", () => {
    expect(
      classifyAuthority("Section 301 duties on certain articles", "9903.02.99"),
    ).toBe("section_301");
  });
});
