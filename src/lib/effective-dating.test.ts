import { describe, expect, it } from "vitest";

import {
  planCloseDate,
  planCommitWindow,
  planWindow,
  resolveWindow,
} from "./effective-dating";

describe("planWindow", () => {
  it("tiles when the effective date post-dates the current window start", () => {
    expect(planWindow("2026-01-01", "2026-06-01")).toEqual({
      action: "tile",
      closePredecessorAt: "2026-05-31",
    });
  });

  it("tiles against an open-start window", () => {
    expect(planWindow(null, "2026-06-01")).toEqual({
      action: "tile",
      closePredecessorAt: "2026-05-31",
    });
  });

  it("corrects in place when the date does not post-date the window start", () => {
    expect(planWindow("2026-06-01", "2026-06-01")).toEqual({
      action: "update_in_place",
    });
    expect(planWindow("2026-06-01", "2026-03-15")).toEqual({
      action: "update_in_place",
    });
  });
});

describe("planCloseDate", () => {
  it("closes at the day before the effective date", () => {
    expect(planCloseDate("2026-01-01", "2026-06-01")).toBe("2026-05-31");
    expect(planCloseDate(null, "2026-06-01")).toBe("2026-05-31");
  });

  it("clamps to the window start so a same-day close is one day long", () => {
    expect(planCloseDate("2026-06-01", "2026-06-01")).toBe("2026-06-01");
  });
});

describe("planCommitWindow", () => {
  it("opens the first window at the effective date when none exists", () => {
    expect(planCommitWindow(null, "2026-06-01")).toEqual({
      action: "insert_first",
      validFrom: "2026-06-01",
    });
  });

  it("opens an open-start first window when no date is given", () => {
    expect(planCommitWindow(null, null)).toEqual({
      action: "insert_first",
      validFrom: null,
    });
  });

  it("treats a dateless commit as a correction of the current window", () => {
    expect(planCommitWindow({ validFrom: "2026-01-01" }, null)).toEqual({
      action: "update_in_place",
    });
  });

  it("tiles a dated commit that post-dates the current window", () => {
    expect(planCommitWindow({ validFrom: "2026-01-01" }, "2026-06-01")).toEqual({
      action: "tile",
      closePredecessorAt: "2026-05-31",
    });
    expect(planCommitWindow({ validFrom: null }, "2026-06-01")).toEqual({
      action: "tile",
      closePredecessorAt: "2026-05-31",
    });
  });

  it("corrects in place on a same-or-earlier dated commit", () => {
    expect(planCommitWindow({ validFrom: "2026-06-01" }, "2026-06-01")).toEqual({
      action: "update_in_place",
    });
    expect(planCommitWindow({ validFrom: "2026-06-01" }, "2026-02-01")).toEqual({
      action: "update_in_place",
    });
  });
});

describe("resolveWindow", () => {
  const oldWindow = { validFrom: null, validTo: "2026-05-31", code: "old" };
  const newWindow = { validFrom: "2026-06-01", validTo: null, code: "new" };
  const windows = [newWindow, oldWindow];

  it("picks the window containing the date", () => {
    expect(resolveWindow(windows, "2026-03-10")).toBe(oldWindow);
    expect(resolveWindow(windows, "2026-07-01")).toBe(newWindow);
  });

  it("treats bounds as inclusive", () => {
    expect(resolveWindow(windows, "2026-05-31")).toBe(oldWindow);
    expect(resolveWindow(windows, "2026-06-01")).toBe(newWindow);
  });

  it("open-start window matches every earlier date", () => {
    expect(resolveWindow(windows, "1999-01-01")).toBe(oldWindow);
  });

  it("falls back to the current window on a null date", () => {
    expect(resolveWindow(windows, null)).toBe(newWindow);
  });

  it("falls back to the current window when no window contains the date", () => {
    const gapped = [
      { validFrom: "2026-01-01", validTo: "2026-01-31", code: "a" },
      { validFrom: "2026-06-01", validTo: null, code: "b" },
    ];
    expect(resolveWindow(gapped, "2026-03-15")?.code).toBe("b");
    expect(resolveWindow(gapped, "2025-01-01")?.code).toBe("b");
  });

  it("returns undefined when every window is closed", () => {
    const closed = [{ validFrom: null, validTo: "2026-05-31", code: "a" }];
    expect(resolveWindow(closed, "2026-07-01")).toBeUndefined();
    expect(resolveWindow(closed, null)).toBeUndefined();
  });

  it("still resolves a closed window containing the date", () => {
    const closed = [{ validFrom: null, validTo: "2026-05-31", code: "a" }];
    expect(resolveWindow(closed, "2026-03-01")?.code).toBe("a");
  });
});
