import { describe, expect, it } from "vitest";

import { deriveEntryStatus } from "./status";

const TODAY = "2026-08-06";

describe("deriveEntryStatus", () => {
  it("filed: no claims at all", () => {
    expect(deriveEntryStatus([], TODAY)).toBe("filed");
  });

  it("filed: claims without liquidation dates (e.g. pre-liquidation PSC refunds)", () => {
    expect(deriveEntryStatus([{ liquidationDate: null }], TODAY)).toBe("filed");
  });

  it("filed: a future liquidation date has not happened yet", () => {
    expect(deriveEntryStatus([{ liquidationDate: "2026-09-01" }], TODAY)).toBe(
      "filed",
    );
  });

  it("liquidated: a past-or-today liquidation date on any claim (inclusive)", () => {
    expect(deriveEntryStatus([{ liquidationDate: "2026-08-06" }], TODAY)).toBe(
      "liquidated",
    );
    expect(
      deriveEntryStatus(
        [{ liquidationDate: null }, { liquidationDate: "2026-05-01" }],
        TODAY,
      ),
    ).toBe("liquidated");
  });
});
