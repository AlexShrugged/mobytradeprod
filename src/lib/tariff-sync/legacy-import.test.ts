import { describe, expect, it } from "vitest";

import {
  buildLegacyRevisions,
  buildReciprocalNote,
  legacyContentHash,
  LegacyImportError,
  mergePrefixMaps,
  parseLegacyMeasures,
  parseMappingCsv,
  type LegacyMeasureRow,
} from "./legacy-import";
import type { LiveMeasureSnapshot, TariffSyncState } from "./types";

describe("parseLegacyMeasures", () => {
  it("normalizes undotted codes, string rates, and defaults", () => {
    const { rows, excluded } = parseLegacyMeasures([
      {
        hts_code: "99038801",
        rate: "0.25",
        description: "Section 301 List 1 (China)",
        full_description: "Section 301 List 1 additional duties (25%)",
        effective_date: "2018-07-06",
        countries: ["CN"],
      },
    ]);
    expect(excluded).toEqual([]);
    expect(rows[0]).toMatchObject({
      htsDigits: "99038801",
      ch99Code: "9903.88.01",
      rate: 0.25,
      effectiveDate: "2018-07-06",
      endDate: null,
      countries: ["CN"],
      exemption: false,
    });
  });

  it("excludes fee_type rows with a reason instead of mis-modeling them", () => {
    const { rows, excluded } = parseLegacyMeasures([
      {
        hts_code: "99031500",
        rate: "0",
        description: "Chinese vessel port fee",
        effective_date: "2025-10-14",
        fee_type: "port_fee",
      },
    ]);
    expect(rows).toEqual([]);
    expect(excluded[0].code).toBe("9903.15.00");
    expect(excluded[0].reason).toContain("port_fee");
  });

  it("rejects non-9903 codes loudly", () => {
    expect(() =>
      parseLegacyMeasures([
        { hts_code: "8501.10.40", rate: "0.1", effective_date: "2025-01-01" },
      ]),
    ).toThrow(LegacyImportError);
  });
});

describe("parseMappingCsv", () => {
  it("handles the General-first column order (section 301 shape)", () => {
    const map = parseMappingCsv(
      "General_HTS,Section_301_HTS\n0101.21.00,9903.88.15\n8501.10.40,9903.88.01\n8501.20.40,9903.88.01\n",
      { ch99Column: "Section_301_HTS", baseColumn: "General_HTS" },
    );
    expect(map.get("99038801")).toEqual(["85011040", "85012040"]);
    expect(map.get("99038815")).toEqual(["01012100"]);
  });

  it("handles the Chapter99-first column order (timber/338 shape)", () => {
    const map = parseMappingCsv(
      "Chapter99_HTS,General_HTS\n9903.76.01,4403.11.00\n9903.76.01,4403.11.00\n",
      { ch99Column: "Chapter99_HTS", baseColumn: "General_HTS" },
    );
    // Duplicate rows collapse.
    expect(map.get("99037601")).toEqual(["44031100"]);
  });

  it("fails loudly on mis-oriented columns (moby's own footgun)", () => {
    expect(() =>
      parseMappingCsv(
        "Chapter99_HTS,General_HTS\n4403.11.00,9903.76.01\n",
        { ch99Column: "Chapter99_HTS", baseColumn: "General_HTS" },
      ),
    ).toThrow(/mis-oriented/);
  });

  it("merges maps by union", () => {
    const merged = mergePrefixMaps([
      new Map([["99038801", ["85011040"]]]),
      new Map([["99038801", ["85012040"]]]),
    ]);
    expect(merged.get("99038801")).toEqual(["85011040", "85012040"]);
  });
});

const curatedRow = (over: Partial<LegacyMeasureRow> = {}): LegacyMeasureRow => ({
  htsDigits: "99038801",
  ch99Code: "9903.88.01",
  rate: 0.25,
  description: "Section 301 List 1 (China)",
  fullDescription: "Section 301 List 1 additional duties on products of China (25%)",
  effectiveDate: "2018-07-06",
  endDate: null,
  countries: ["CN"],
  exemption: false,
  ...over,
});

const liveSnapshot = (over: Partial<LiveMeasureSnapshot> = {}): LiveMeasureSnapshot => ({
  measureId: "measure-1",
  ch99Code: "9903.88.01",
  ch99Digits: "99038801",
  name: "Section 301 List 1",
  authority: "section_301",
  scope: "hts_list",
  countries: ["CN"],
  effectiveDate: "2018-07-06",
  endDate: null,
  sailedOnOrAfter: null,
  sailedOnOrBefore: null,
  rate: 0.25,
  exemption: false,
  description: "Section 301 List 1",
  prefixes: ["8501"],
  ...over,
});

const emptyState: TariffSyncState = { byDigits: new Map() };

describe("buildLegacyRevisions", () => {
  it("stages an unknown code as a fully-dated create_measure with prefixes", () => {
    const { revisions } = buildLegacyRevisions(
      [curatedRow()],
      new Map([["99038801", ["85011040", "85012040"]]]),
      emptyState,
      [],
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      changeType: "create_measure",
      ch99Code: "9903.88.01",
      authority: "section_301",
    });
    expect(revisions[0].proposed).toMatchObject({
      scope: "hts_list",
      countries: ["CN"],
      effectiveDate: "2018-07-06",
      rate: 0.25,
      prefixes: ["85011040", "85012040"],
    });
    expect(revisions[0].proposed.notes).toContain("legacy moby");
  });

  it("backfiller dates override the JSON's (newer curation wins)", () => {
    // 9903.01.22 is in BACKFILLER_DATES with the IEEPA termination end date.
    const { revisions } = buildLegacyRevisions(
      [
        curatedRow({
          htsDigits: "99030122",
          ch99Code: "9903.01.22",
          description: "IEEPA China opioid",
          fullDescription: "IEEPA China opioid additional duties",
          effectiveDate: "2025-02-01", // JSON's (older) date
          endDate: null,
        }),
      ],
      new Map(),
      emptyState,
      [],
    );
    expect(revisions[0].proposed.effectiveDate).toBe("2025-02-04");
    expect(revisions[0].proposed.endDate).toBe("2026-02-23");
    expect(revisions[0].authority).toBe("ieepa");
  });

  it("skips codes already live with no material difference", () => {
    const state: TariffSyncState = {
      byDigits: new Map([["99038801", liveSnapshot()]]),
    };
    const { revisions, skippedLive } = buildLegacyRevisions(
      [curatedRow()],
      new Map(),
      state,
      [],
    );
    expect(revisions).toEqual([]);
    expect(skippedLive).toEqual(["9903.88.01"]);
  });

  it("stages a rate_change against a live measure whose rate differs", () => {
    const state: TariffSyncState = {
      byDigits: new Map([["99038801", liveSnapshot({ rate: 0.075 })]]),
    };
    const { revisions } = buildLegacyRevisions([curatedRow()], new Map(), state, []);
    expect(revisions[0]).toMatchObject({
      changeType: "rate_change",
      targetMeasureId: "measure-1",
    });
    expect(revisions[0].proposed.rate).toBe(0.25);
  });

  it("dedupes against identical open proposals (re-run idempotency)", () => {
    const row = curatedRow();
    const hash = legacyContentHash(row, []);
    const { revisions, skippedPending } = buildLegacyRevisions(
      [row],
      new Map(),
      emptyState,
      [
        {
          revisionId: "r1",
          reviewItemId: "i1",
          announcementId: "a1",
          ch99Digits: "99038801",
          contentHash: hash,
        },
      ],
    );
    expect(revisions).toEqual([]);
    expect(skippedPending).toEqual(["9903.88.01"]);
  });

  it("changed curated data re-stages (hash differs)", () => {
    const row = curatedRow();
    const staleHash = legacyContentHash(curatedRow({ rate: 0.075 }), []);
    const { revisions } = buildLegacyRevisions([row], new Map(), emptyState, [
      {
        revisionId: "r1",
        reviewItemId: "i1",
        announcementId: "a1",
        ch99Digits: "99038801",
        contentHash: staleHash,
      },
    ]);
    expect(revisions).toHaveLength(1);
  });

  it("marks exemption rows and zeroes their rate", () => {
    const { revisions } = buildLegacyRevisions(
      [
        curatedRow({
          htsDigits: "99038867",
          ch99Code: "9903.88.67",
          rate: 0,
          exemption: true,
          description: "Section 301 exclusion",
          fullDescription: "Section 301 exclusions for certain products",
        }),
      ],
      new Map(),
      emptyState,
      [],
    );
    expect(revisions[0].proposed.exemption).toBe(true);
    expect(revisions[0].proposed.rate).toBe(0);
  });

  it("classifies the Section 232 product actions into their own authorities", () => {
    const { revisions } = buildLegacyRevisions(
      [
        curatedRow({
          htsDigits: "99037801",
          ch99Code: "9903.78.01",
          description: "Section 232 Copper",
          fullDescription: "Section 232 tariff on semi-finished copper products",
          rate: 0.5,
          countries: null,
        }),
        curatedRow({
          htsDigits: "99039601",
          ch99Code: "9903.96.01",
          description: "Softwood Timber Tariff",
          fullDescription: "10% tariff on softwood timber and lumber imports",
          rate: 0.1,
          countries: null,
        }),
      ],
      new Map(),
      emptyState,
      [],
    );
    expect(revisions.map((r) => r.authority)).toEqual([
      "section_232_copper",
      "section_232_timber_furniture",
    ]);
  });

  it("families the differ can't name land as 'other' with the name preserved", () => {
    const { revisions } = buildLegacyRevisions(
      [
        curatedRow({
          htsDigits: "99039901",
          ch99Code: "9903.99.01",
          description: "China Rare Earths Response",
          fullDescription: "Additional duties on certain rare earth articles",
          rate: 1,
          countries: ["CN"],
        }),
      ],
      new Map(),
      emptyState,
      [],
    );
    expect(revisions[0].authority).toBe("other");
    expect(revisions[0].proposed.name).toBe("China Rare Earths Response");
  });
});

describe("buildReciprocalNote", () => {
  it("summarizes annex country rates", () => {
    const note = buildReciprocalNote(
      "Country,Tariff Charged to the USA,USA Reciprocal Tariff\nChina,67%,34%\nEuropean Union,39%,20%\n",
    );
    expect(note).toContain("China 34%");
    expect(note).toContain("European Union 20%");
  });
});
