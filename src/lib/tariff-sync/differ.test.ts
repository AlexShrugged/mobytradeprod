import { describe, expect, it } from "vitest";

import { contentHashOf, detectCountries, diffRelease } from "./differ";
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
