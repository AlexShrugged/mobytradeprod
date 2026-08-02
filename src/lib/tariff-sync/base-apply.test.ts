import { describe, expect, it } from "vitest";

import { planBaseClose, planBaseWindow } from "./base-apply";

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
