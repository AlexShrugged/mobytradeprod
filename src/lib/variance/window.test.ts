import { describe, expect, it } from "vitest";

import { liquidationWindow } from "./window";

describe("liquidationWindow", () => {
  it("estimates entry date + 314 days", () => {
    expect(liquidationWindow("2026-01-01", "released", "2026-01-01")).toEqual({
      estDate: "2026-11-11",
      daysLeft: 314,
      closed: false,
    });
  });

  it("counts down and goes negative past the estimate", () => {
    expect(
      liquidationWindow("2026-01-01", "filed", "2026-11-21").daysLeft,
    ).toBe(-10);
  });

  it("closes the window on liquidated entries but keeps the date", () => {
    expect(liquidationWindow("2026-01-01", "liquidated", "2026-06-01")).toEqual(
      { estDate: "2026-11-11", daysLeft: null, closed: true },
    );
  });

  it("yields no window without an entry date", () => {
    expect(liquidationWindow(null, "filed", "2026-06-01")).toEqual({
      estDate: null,
      daysLeft: null,
      closed: false,
    });
    expect(liquidationWindow(null, "liquidated", "2026-06-01").closed).toBe(
      true,
    );
  });
});
