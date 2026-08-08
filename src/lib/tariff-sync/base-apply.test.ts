import { describe, expect, it } from "vitest";

import {
  planBaseChange,
  planBaseClose,
  planBaseWindow,
  SEED_RELEASE,
} from "./base-apply";

describe("planBaseWindow (changed codes)", () => {
  it("tiles a later-dated change: successor opens at eff, predecessor closes at eff−1", () => {
    expect(planBaseWindow("2025-01-01", "2026-08-01")).toEqual({
      action: "tile",
      closePredecessorAt: "2026-07-31",
    });
  });

  it("handles month and year boundaries in the close date", () => {
    expect(planBaseWindow("2025-01-01", "2026-01-01")).toEqual({
      action: "tile",
      closePredecessorAt: "2025-12-31",
    });
    expect(planBaseWindow("2025-01-01", "2026-03-01")).toEqual({
      action: "tile",
      closePredecessorAt: "2026-02-28",
    });
  });

  it("a window with no recorded start (legacy row) still tiles", () => {
    expect(planBaseWindow(null, "2026-08-01")).toEqual({
      action: "tile",
      closePredecessorAt: "2026-07-31",
    });
  });

  it("same-day or earlier effective date corrects the window in place", () => {
    // Tiling here would close the predecessor before it opened.
    expect(planBaseWindow("2026-08-01", "2026-08-01")).toEqual({
      action: "update_in_place",
    });
    expect(planBaseWindow("2026-08-01", "2026-07-15")).toEqual({
      action: "update_in_place",
    });
  });
});

describe("planBaseClose (removed codes)", () => {
  it("closes on the day before the release takes effect", () => {
    expect(planBaseClose("2025-01-01", "2026-08-01")).toBe("2026-07-31");
  });

  it("clamps to the window's own start instead of inverting the range", () => {
    // Window opened the same day the removal takes effect: one-day window.
    expect(planBaseClose("2026-08-01", "2026-08-01")).toBe("2026-08-01");
    expect(planBaseClose("2026-08-01", "2026-07-01")).toBe("2026-08-01");
  });

  it("legacy rows without a start close normally", () => {
    expect(planBaseClose(null, "2026-01-01")).toBe("2025-12-31");
  });
});

describe("planBaseChange (SEED correction)", () => {
  it("always corrects SEED windows in place — approximations are not history", () => {
    // A later-dated release would normally tile; SEED rows never do.
    expect(
      planBaseChange({ validFrom: "2025-01-01", release: SEED_RELEASE }, "2026-08-01"),
    ).toEqual({ action: "update_in_place" });
  });

  it("delegates certified windows to the pinned tiling planner", () => {
    expect(
      planBaseChange({ validFrom: "2025-01-01", release: "2026HTSRev9" }, "2026-08-01"),
    ).toEqual({ action: "tile", closePredecessorAt: "2026-07-31" });
    expect(
      planBaseChange({ validFrom: "2026-08-01", release: "2026HTSRev9" }, "2026-08-01"),
    ).toEqual({ action: "update_in_place" });
  });

  it("treats a null release like any certified window (never guesses SEED)", () => {
    expect(
      planBaseChange({ validFrom: "2025-01-01", release: null }, "2026-08-01"),
    ).toEqual({ action: "tile", closePredecessorAt: "2026-07-31" });
  });
});
