import { describe, expect, it } from "vitest";

import {
  classifyAuthority,
  contentHashOf,
  detectCountries,
  diffRelease,
  familyAuthorities,
  headingSubject,
} from "./differ";
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

// Live USITC text, 2026-09-18. 9903.05.89/.90 (and their Brazil twins
// .06/.07) were labeled "Section 232 Pharma" on prod because the weak
// product cue read "pharmaceutical" anywhere in the text; ASC files
// 9903.05.90 on 134 charges of steel and brass pipe fittings.
const NOTE_52_METALS_EXEMPTION =
  "Articles of aluminum, of steel or of copper or derivative aluminum or steel articles; passenger vehicles (sedans, sport utility vehicles, crossover utility vehicles, minivans and cargo vans) and light trucks; parts of passenger vehicles (sedans, sport utility vehicles, crossover utility vehicles, minivans and cargo vans) and light trucks; medium- and heavy-duty vehicles; parts of medium- and heavy-duty vehicles; wood products; patented pharmaceutical articles; and semiconductor articles, as provided in subdivision (f) of U.S. note 52 to this subchapter";
const NOTE_52_PHARMA_USE_EXEMPTION =
  "Articles for use in pharmaceutical applications, as provided for in subdivision (e) of U.S. note 52 to this subchapter";
const EXEMPT = "The duty provided in the applicable subheading";

describe("classifyAuthority — pharma is read from the heading's subject", () => {
  const notPharma: [string, string][] = [
    [NOTE_52_METALS_EXEMPTION, "9903.05.90"],
    [NOTE_52_PHARMA_USE_EXEMPTION, "9903.05.89"],
    [
      "Articles the product of Brazil that are articles for use in pharmaceutical applications, as provided for in subdivision (a)(v) of U.S. note 50 to this subchapter",
      "9903.05.06",
    ],
    [
      "Articles that are donations by persons subject to the jurisdiction of the United States, such as food, clothing and medicine, intended to be used to relieve human suffering",
      "9903.05.91",
    ],
  ];
  for (const [description, htsno] of notPharma) {
    it(`${htsno} is not the pharma tariff`, () => {
      expect(classifyAuthority(description, htsno)).toBe("other");
    });
  }

  // The genuine Section 232 pharma action (U.S. note 40) — none of these
  // name the statute, so the subject cue is all that classifies them.
  const pharma: [string, string][] = [
    [
      "Except as provided in heading 9903.04.61, patented pharmaceutical articles as provided for in subdivisions (c) and (d) of U.S. note 40 to this subchapter",
      "9903.04.60",
    ],
    [
      "Patented pharmaceutical articles entered before 12:01 a.m. eastern time on September 29, 2026 as provided for in subdivisions (c) and (e) of U.S. note 40 to this subchapter",
      "9903.04.61",
    ],
    [
      "Patented pharmaceutical articles that are the product of Japan, of a European Union member country, of South Korea, of Switzerland, or of Liechtenstein as provided for in subdivisions (c) and (f) of U.S. note 40 to this subchapter",
      "9903.04.62",
    ],
    [
      "Pharmaceutical articles subject to a qualifying onshoring plan and a Most-Favored-Nation pharmaceutical pricing agreement, as provided for in subdivisions (c) and (h)(ii) of U.S. note 40 to this subchapter",
      "9903.04.65",
    ],
    [
      "Drugs and pharmaceutical articles for the specific uses provided in subdivisions (c) and (h)(iii) of U.S. note 40 to this subchapter",
      "9903.04.66",
    ],
    [
      "Generic pharmaceutical articles, as provided for in subdivision (c) of U.S. note 40 to this subchapter",
      "9903.04.67",
    ],
    [
      "Pharmaceutical products with an active pharmaceutical ingredient packaged in dosage form that is a product of the United States",
      "9903.04.68",
    ],
  ];
  for (const [description, htsno] of pharma) {
    it(`${htsno} is the pharma tariff`, () => {
      expect(classifyAuthority(description, htsno)).toBe("section_232_pharma");
    });
  }

  it("a Section 232 carve-out list naming pharmaceuticals is not bucketed pharma", () => {
    expect(
      classifyAuthority(
        "Articles subject to Section 232 actions: articles of steel; wood products; patented pharmaceutical articles",
        "9903.07.01",
      ),
    ).not.toBe("section_232_pharma");
  });

  it("the subject stops at the first qualifier, use clause or list item", () => {
    expect(headingSubject(NOTE_52_METALS_EXEMPTION)).toBe("articles of aluminum");
    expect(headingSubject(NOTE_52_PHARMA_USE_EXEMPTION)).toBe("articles");
    expect(
      headingSubject(
        "Except as provided in heading 9903.04.61, patented pharmaceutical articles as provided for in note 40",
      ),
    ).toBe("patented pharmaceutical articles");
  });
});

describe("an exemption heading takes its family's authority", () => {
  const vietnam = row({
    htsno: "9903.05.84",
    description:
      "Except for products described in headings 9903.05.85–9903.05.92, articles the product of Vietnam, as provided for in U.S. note 52 to this subchapter",
    general: "The duty provided in the applicable subheading + 12.5%",
  });
  const metals = row({
    htsno: "9903.05.90",
    description: NOTE_52_METALS_EXEMPTION,
    general: EXEMPT,
  });

  it("stages 9903.05.90 under its family, never under the goods it lists", () => {
    const { revisions } = diffRelease([vietnam, metals], stateWith(), []);
    const rev = revisions.find((r) => r.ch99Code === "9903.05.90")!;
    expect(rev.proposed.exemption).toBe(true);
    expect(rev.authority).toBe("other");
    expect(rev.proposed.name).toBe("Trade measure — 9903.05.90");
  });

  it("the family's LIVE authority wins over the classifier", () => {
    const state = stateWith(
      live({
        measureId: "vn",
        ch99Code: "9903.05.84",
        ch99Digits: "99030584",
        authority: "reciprocal",
      }),
    );
    expect(familyAuthorities([vietnam, metals], state).get("990305")).toBe(
      "reciprocal",
    );
    const { revisions } = diffRelease([vietnam, metals], state, []);
    expect(
      revisions.find((r) => r.ch99Code === "9903.05.90")!.authority,
    ).toBe("reciprocal");
  });

  it("an exemption text naming another statute still follows its family", () => {
    const steelCarveOut = row({
      htsno: "9903.05.99",
      description:
        "Articles of iron or steel subject to Section 232 duties, as provided for in U.S. note 52",
      general: EXEMPT,
    });
    const { revisions } = diffRelease([vietnam, steelCarveOut], stateWith(), []);
    expect(
      revisions.find((r) => r.ch99Code === "9903.05.99")!.authority,
    ).toBe("other");
  });

  it("a split family decides nothing: the row is read from its own text", () => {
    const gin = row({
      htsno: "9903.04.55",
      description:
        "Gin, in containers each holding not over 3.8 liters (provided for in subheading 2208.50)",
      general: "200%",
    });
    const pharmaRate = row({
      htsno: "9903.04.60",
      description:
        "Except as provided in heading 9903.04.61, patented pharmaceutical articles as provided for in subdivisions (c) and (d) of U.S. note 40 to this subchapter",
      general: "100%",
    });
    const generic = row({
      htsno: "9903.04.67",
      description:
        "Generic pharmaceutical articles, as provided for in subdivision (c) of U.S. note 40 to this subchapter",
      general: EXEMPT,
    });
    const rows = [gin, pharmaRate, generic];
    expect(familyAuthorities(rows, stateWith()).has("990304")).toBe(false);
    const { revisions } = diffRelease(rows, stateWith(), []);
    expect(
      revisions.find((r) => r.ch99Code === "9903.04.67")!.authority,
    ).toBe("section_232_pharma");
  });
});

describe("ceiling headings: rate idiom → in lieu + column-1 gate", () => {
  it("a bare rate with a 'less than N percent' clause stages in lieu, gated", () => {
    const taiwan = row({
      htsno: "9903.05.76",
      description:
        "Except for products described in headings 9903.05.85–9903.05.92 and 9903.06.14–9903.06.15, articles the product of Taiwan, with an ad valorem (or ad valorem equivalent) rate of duty under column 1 less than 10 percent, as provided for in U.S. note 52 to this subchapter",
      general: "10%",
    });
    const { revisions } = diffRelease([taiwan], stateWith(), []);
    expect(revisions).toHaveLength(1);
    const p = revisions[0].proposed;
    expect(p.exemption).toBe(false);
    expect(p.rate).toBe(0.1);
    expect(p.inLieuOfBaseDuty).toBe(true);
    expect(p.col1RateBelow).toBe(0.1);
    expect(p.countries).toEqual(["TW"]);
  });

  it("a bare rate with no clause is a ceiling at its own rate", () => {
    const timber = row({
      htsno: "9903.76.24",
      description:
        "Wood products of Taiwan as provided for in subdivisions (d) and (f) of U.S. note 37 of this subchapter",
      general: "15%",
    });
    const { revisions } = diffRelease([timber], stateWith(), []);
    expect(revisions[0].proposed.inLieuOfBaseDuty).toBe(true);
    expect(revisions[0].proposed.col1RateBelow).toBe(0.15);
  });

  it("the additive idiom stays additive and ungated", () => {
    const algeria = row({
      htsno: "9903.05.20",
      description:
        "Except for products described in headings 9903.05.85–9903.05.92, articles the product of Algeria, as provided for in U.S. note 52 to this subchapter",
      general: "The duty provided in the applicable subheading + 12.5%",
    });
    const { revisions } = diffRelease([algeria], stateWith(), []);
    expect(revisions[0].proposed.inLieuOfBaseDuty).toBe(false);
    expect(revisions[0].proposed.col1RateBelow).toBeNull();
  });

  it("a live measure stored flat under a bare-rate heading stages a rate_change carrying the ceiling", () => {
    const description =
      "articles the product of Taiwan, with an ad valorem rate of duty under column 1 less than 10 percent";
    const flat = live({
      measureId: "tw",
      ch99Code: "9903.05.76",
      ch99Digits: "99030576",
      name: "Trade measure — 9903.05.76",
      authority: "other",
      scope: "all_products",
      countries: ["TW"],
      rate: 0.1,
      description,
      prefixes: [],
      inLieuOfBaseDuty: false,
      col1RateBelow: null,
    });
    const r = row({ htsno: "9903.05.76", description, general: "10%" });
    const { revisions } = diffRelease([r], stateWith(flat), []);
    expect(revisions.map((x) => x.changeType)).toEqual(["rate_change"]);
    expect(revisions[0].proposed.inLieuOfBaseDuty).toBe(true);
    expect(revisions[0].proposed.col1RateBelow).toBe(0.1);

    // Once live agrees with the published shape, nothing stages.
    const settled = live({ ...flat, inLieuOfBaseDuty: true, col1RateBelow: 0.1 });
    expect(diffRelease([r], stateWith(settled), []).revisions).toEqual([]);
  });

  it("end_measure carries the live measure's ceiling shape", () => {
    const ceiling = live({
      ch99Code: "9903.05.76",
      ch99Digits: "99030576",
      rate: 0.1,
      inLieuOfBaseDuty: true,
      col1RateBelow: 0.1,
    });
    const { revisions } = diffRelease([], stateWith(ceiling), []);
    expect(revisions[0].changeType).toBe("end_measure");
    expect(revisions[0].proposed.inLieuOfBaseDuty).toBe(true);
    expect(revisions[0].proposed.col1RateBelow).toBe(0.1);
  });
});
