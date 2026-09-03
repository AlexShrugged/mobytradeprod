import { describe, expect, it } from "vitest";

import {
  partInScope,
  proposalChangeDates,
  resolveChangeWindow,
} from "./reconsider";

describe("resolveChangeWindow", () => {
  const NOW = "2026-09-02";

  it("no dates: yesterday vs today", () => {
    expect(resolveChangeWindow([], NOW)).toEqual({
      asOfBefore: "2026-09-01",
      asOfAfter: "2026-09-02",
    });
  });

  it("a past change: the day before it opened vs today", () => {
    expect(resolveChangeWindow(["2026-08-01"], NOW)).toEqual({
      asOfBefore: "2026-07-31",
      asOfAfter: "2026-09-02",
    });
  });

  it("a future change: the day before vs the change date itself", () => {
    expect(resolveChangeWindow(["2026-10-01"], NOW)).toEqual({
      asOfBefore: "2026-09-30",
      asOfAfter: "2026-10-01",
    });
  });

  it("several dates: earliest before, latest after; junk ignored", () => {
    expect(
      resolveChangeWindow(["2026-10-01", "not-a-date", "2026-08-15"], NOW),
    ).toEqual({ asOfBefore: "2026-08-14", asOfAfter: "2026-10-01" });
  });
});

describe("partInScope", () => {
  it("an all_products change reaches every part", () => {
    expect(partInScope(["8501314000"], { prefixes: null })).toBe(true);
    expect(partInScope([], { prefixes: null })).toBe(true);
  });

  it("matches a Ch99 prefix against any potential code", () => {
    expect(partInScope(["4011500000", "8501314000"], { prefixes: ["8501"] })).toBe(true);
    expect(partInScope(["4011500000"], { prefixes: ["8501"] })).toBe(false);
  });

  it("matches exact base digits", () => {
    expect(
      partInScope(["8501314000"], { prefixes: [], digits: ["8501314000"] }),
    ).toBe(true);
    expect(
      partInScope(["8501318000"], { prefixes: [], digits: ["8501314000"] }),
    ).toBe(false);
  });

  it("a codeless part never matches a scoped change", () => {
    expect(partInScope([], { prefixes: ["85"] })).toBe(false);
  });
});

describe("proposalChangeDates", () => {
  it("effective date plus the day after an end date", () => {
    expect(
      proposalChangeDates({ effectiveDate: "2026-08-01", endDate: "2026-12-31" }),
    ).toEqual(["2026-08-01", "2027-01-01"]);
  });

  it("nulls contribute nothing", () => {
    expect(proposalChangeDates({ effectiveDate: null, endDate: null })).toEqual([]);
    expect(proposalChangeDates({ effectiveDate: "2026-08-01", endDate: null })).toEqual([
      "2026-08-01",
    ]);
  });
});
