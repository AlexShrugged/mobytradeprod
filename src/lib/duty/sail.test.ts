import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import { computeExpectedCharges, resolveExpectedMeasures } from "./calculator";
import { resolveSailInfo } from "./sail";
import type { MeasureRef, ReferenceData, SailInfo } from "./types";

// Fixed anchor (2026-08-11) so the seed's day-relative Section 122 pair
// lands on mobynew's canonical timeline: cutoff day(-10) = 2026-08-01,
// last pre-cutoff sail day(-11) = 2026-07-31.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const seedRef = buildSeedReferenceData(day);

// ---------------------------------------------------------------- resolveSailInfo

describe("resolveSailInfo", () => {
  it("min/maxes across shipments and prefers on-board dates", () => {
    const info = resolveSailInfo([
      { sailedOnBoardDate: "2026-07-15", etd: "2026-07-14" },
      { sailedOnBoardDate: "2026-08-02", etd: null },
    ]);
    expect(info).toEqual({
      earliestSail: "2026-07-15",
      latestSail: "2026-08-02",
      estimated: false,
    });
  });

  it("falls back to ETD and flags the result estimated", () => {
    const info = resolveSailInfo([
      { sailedOnBoardDate: "2026-07-15", etd: null },
      { sailedOnBoardDate: null, etd: "2026-07-20" },
    ]);
    expect(info).toEqual({
      earliestSail: "2026-07-15",
      latestSail: "2026-07-20",
      estimated: true,
    });
  });

  it("dateless shipments contribute nothing; all-dateless yields nulls", () => {
    expect(
      resolveSailInfo([
        { sailedOnBoardDate: null, etd: null },
        { sailedOnBoardDate: "2026-07-15", etd: null },
      ]),
    ).toEqual({
      earliestSail: "2026-07-15",
      latestSail: "2026-07-15",
      estimated: false,
    });
    expect(resolveSailInfo([{ sailedOnBoardDate: null, etd: null }])).toEqual({
      earliestSail: null,
      latestSail: null,
      estimated: false,
    });
    expect(resolveSailInfo([])).toEqual({
      earliestSail: null,
      latestSail: null,
      estimated: false,
    });
  });
});

// ---------------------------------------------------------------- sail gate

function measure(over: Partial<MeasureRef>): MeasureRef {
  return {
    id: "m",
    name: "Sail-conditioned measure",
    authority: "section_122",
    scope: "all_products",
    countries: null,
    effectiveDate: "2026-08-01",
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    inLieuOfBaseDuty: false,
    ch99Code: "9903.03.01",
    ch99Digits: "99030301",
    rate: 0.1,
    exclusionDigits: [],
    prefixes: [],
    ...over,
  };
}

function refWith(...measures: MeasureRef[]): ReferenceData {
  return {
    htsByDigits: seedRef.htsByDigits,
    measures,
    stackingRules: [],
  };
}

function line(sail: SailInfo | null, entryDate = "2026-08-05") {
  return {
    htsDigits: "8501314000",
    countryOfOrigin: "CN",
    enteredValueCents: 1_000_000,
    entryDate,
    sail,
  };
}

const exact = (date: string): SailInfo => ({
  earliestSail: date,
  latestSail: date,
  estimated: false,
});

describe("sail-conditioned measures", () => {
  const onOrAfter = measure({ sailedOnOrAfter: "2026-08-01" });
  const onOrBefore = measure({ sailedOnOrBefore: "2026-07-31" });

  it("no sail conditions -> sailBasis null regardless of sail info", () => {
    const plain = measure({});
    const r = resolveExpectedMeasures(line(null), refWith(plain));
    expect(r.applicable.map((m) => m.id)).toEqual(["m"]);
    expect(r.sailBasis).toBeNull();
  });

  it("sailed_on_or_after: applies on exact pass, drops on exact fail", () => {
    const pass = resolveExpectedMeasures(
      line(exact("2026-08-03")),
      refWith(onOrAfter),
    );
    expect(pass.applicable).toHaveLength(1);
    expect(pass.sailBasis).toBe("exact");

    const fail = resolveExpectedMeasures(
      line(exact("2026-07-20")),
      refWith(onOrAfter),
    );
    expect(fail.applicable).toHaveLength(0);
    expect(fail.sailBasis).toBe("exact");
  });

  it("sailed_on_or_before: applies on exact pass, drops on exact fail", () => {
    const pass = resolveExpectedMeasures(
      line(exact("2026-07-20")),
      refWith(onOrBefore),
    );
    expect(pass.applicable).toHaveLength(1);
    expect(pass.sailBasis).toBe("exact");

    const fail = resolveExpectedMeasures(
      line(exact("2026-08-03")),
      refWith(onOrBefore),
    );
    expect(fail.applicable).toHaveLength(0);
    expect(fail.sailBasis).toBe("exact");
  });

  it("unknown sail dates -> measure applies (duty owed) and basis is assumed", () => {
    for (const sail of [null, resolveSailInfo([])]) {
      const r = resolveExpectedMeasures(line(sail), refWith(onOrAfter));
      expect(r.applicable).toHaveLength(1);
      expect(r.sailBasis).toBe("assumed");
    }
  });

  it("ETD-derived dates report basis estimated", () => {
    const sail: SailInfo = {
      earliestSail: "2026-08-03",
      latestSail: "2026-08-03",
      estimated: true,
    };
    const r = resolveExpectedMeasures(line(sail), refWith(onOrAfter));
    expect(r.applicable).toHaveLength(1);
    expect(r.sailBasis).toBe("estimated");
  });

  it("multi-shipment window straddling the cutoff applies and is assumed", () => {
    const sail: SailInfo = {
      earliestSail: "2026-07-20",
      latestSail: "2026-08-03",
      estimated: false,
    };
    const r = resolveExpectedMeasures(line(sail), refWith(onOrAfter));
    expect(r.applicable).toHaveLength(1);
    expect(r.sailBasis).toBe("assumed");
  });

  it("window entirely outside the condition still drops it (provable miss)", () => {
    const sail: SailInfo = {
      earliestSail: "2026-07-10",
      latestSail: "2026-07-20",
      estimated: false,
    };
    const r = resolveExpectedMeasures(line(sail), refWith(onOrAfter));
    expect(r.applicable).toHaveLength(0);
  });

  it("combined savings clause on one row: entry window AND sail cutoff", () => {
    // Grace row: goods laden by Jul 31 owe nothing extra if entered by Aug 10.
    const grace = measure({
      id: "grace",
      sailedOnOrBefore: "2026-07-31",
      effectiveDate: "2026-08-01",
      endDate: "2026-08-10",
      rate: 0,
    });
    const inGrace = resolveExpectedMeasures(
      line(exact("2026-07-15"), "2026-08-05"),
      refWith(grace),
    );
    expect(inGrace.applicable.map((m) => m.id)).toEqual(["grace"]);

    const pastGrace = resolveExpectedMeasures(
      line(exact("2026-07-15"), "2026-08-20"),
      refWith(grace),
    );
    expect(pastGrace.applicable).toHaveLength(0);
  });

  it("sail-tiled siblings dedupe to the costlier row when sail is unknown", () => {
    const post = measure({ id: "post", sailedOnOrAfter: "2026-08-01", rate: 0.1 });
    const grace = measure({
      id: "grace",
      sailedOnOrBefore: "2026-07-31",
      rate: 0.05,
    });
    const r = resolveExpectedMeasures(line(null), refWith(post, grace));
    expect(r.applicable.map((m) => m.id)).toEqual(["post"]);
    expect(r.sailBasis).toBe("assumed");
  });

  it("known sail date picks exactly one tiled sibling, basis exact", () => {
    const post = measure({ id: "post", sailedOnOrAfter: "2026-08-01", rate: 0.1 });
    const grace = measure({
      id: "grace",
      sailedOnOrBefore: "2026-07-31",
      rate: 0.05,
    });
    const r = resolveExpectedMeasures(
      line(exact("2026-07-15")),
      refWith(post, grace),
    );
    expect(r.applicable.map((m) => m.id)).toEqual(["grace"]);
    expect(r.sailBasis).toBe("exact");
  });

  it("computeExpectedCharges surfaces sailBasis and charges the survivor", () => {
    const post = measure({ id: "post", sailedOnOrAfter: "2026-08-01", rate: 0.1 });
    const result = computeExpectedCharges(line(null), refWith(post));
    expect(result.sailBasis).toBe("assumed");
    expect(result.measures).toHaveLength(1);
    expect(result.measures[0].amountCents).toBe(100_000);
  });

  it("only the Section 122 seed rows carry sail conditions", () => {
    for (const m of seedRef.measures) {
      if (m.authority === "section_122") continue;
      expect(m.sailedOnOrAfter).toBeNull();
      expect(m.sailedOnOrBefore).toBeNull();
    }
    const s122 = seedRef.measures.filter((m) => m.authority === "section_122");
    expect(s122.map((m) => [m.sailedOnOrAfter, m.sailedOnOrBefore]).sort()).toEqual([
      [null, "2026-07-31"],
      ["2026-08-01", null],
    ]);
    // Both rows must ride the same Chapter 99 code — the tiling the
    // calculator's dedupe rule exists for.
    expect(new Set(s122.map((m) => m.ch99Digits)).size).toBe(1);
  });
});
