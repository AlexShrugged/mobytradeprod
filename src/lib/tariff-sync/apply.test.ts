import { describe, expect, it } from "vitest";

import { ApplyValidationError, dayBefore, planRevisionApply } from "./apply";
import type { ProposedMeasureChange } from "./types";

function proposed(over: Partial<ProposedMeasureChange> = {}): ProposedMeasureChange {
  return {
    name: "IEEPA Reciprocal Tariff — baseline",
    authority: "reciprocal",
    scope: "all_products",
    countries: null,
    effectiveDate: "2026-09-01",
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    rate: 0.15,
    exemption: false,
    inLieuOfBaseDuty: false,
    prefixes: [],
    notes: null,
    ...over,
  };
}

describe("planRevisionApply", () => {
  const liveWindow = { effectiveDate: "2025-04-05", endDate: null };

  it("tiles a later-dated rate change and closes the predecessor at eff−1", () => {
    const plan = planRevisionApply("rate_change", proposed(), liveWindow, null);
    expect(plan).toEqual({ action: "tile", closePredecessorAt: "2026-08-31" });
  });

  it("same-or-earlier effective date updates the live window in place", () => {
    expect(
      planRevisionApply(
        "rate_change",
        proposed({ effectiveDate: "2025-04-05" }),
        liveWindow,
        null,
      ),
    ).toEqual({ action: "update_in_place" });
    expect(
      planRevisionApply(
        "note_change",
        proposed({ effectiveDate: "2024-01-01" }),
        liveWindow,
        null,
      ),
    ).toEqual({ action: "update_in_place" });
  });

  it("create_measure needs an effective date and (unless exempt) a rate", () => {
    expect(
      planRevisionApply(
        "create_measure",
        proposed({ worldwide: true }),
        null,
        null,
      ),
    ).toEqual({ action: "insert_new" });
    expect(() =>
      planRevisionApply("create_measure", proposed({ effectiveDate: null }), null, null),
    ).toThrow(ApplyValidationError);
    expect(() =>
      planRevisionApply("create_measure", proposed({ rate: null }), null, null),
    ).toThrow(ApplyValidationError);
    // Exemption lines apply with rate null — they carry 0 by definition.
    expect(
      planRevisionApply(
        "create_measure",
        proposed({ rate: null, exemption: true }),
        null,
        null,
      ),
    ).toEqual({ action: "insert_new" });
  });

  it("create_measure with null countries needs the explicit worldwide confirmation", () => {
    // The fail-open that minted worldwide measures from unparsed
    // per-country headings: null countries, no confirmation → refuse.
    expect(() =>
      planRevisionApply("create_measure", proposed(), null, null),
    ).toThrow(/country scope/);
    // Explicit country list needs no confirmation …
    expect(
      planRevisionApply(
        "create_measure",
        proposed({ countries: ["CN"] }),
        null,
        null,
      ),
    ).toEqual({ action: "insert_new" });
    // … and exemption rows are carve-outs, not liabilities: no gate.
    expect(
      planRevisionApply(
        "create_measure",
        proposed({ exemption: true, rate: 0 }),
        null,
        null,
      ),
    ).toEqual({ action: "insert_new" });
  });

  it("end_measure takes the proposed end date, else the announcement date", () => {
    expect(
      planRevisionApply(
        "end_measure",
        proposed({ endDate: "2026-12-31" }),
        liveWindow,
        "2026-08-01",
      ),
    ).toEqual({ action: "end", endDate: "2026-12-31" });
    expect(
      planRevisionApply("end_measure", proposed({ endDate: null }), liveWindow, "2026-08-01"),
    ).toEqual({ action: "end", endDate: "2026-08-01" });
    expect(() =>
      planRevisionApply("end_measure", proposed({ endDate: null }), liveWindow, null),
    ).toThrow(ApplyValidationError);
  });

  it("rate/scope changes without a date or target are rejected", () => {
    expect(() =>
      planRevisionApply("rate_change", proposed({ effectiveDate: null }), liveWindow, null),
    ).toThrow(/effective date/);
    expect(() => planRevisionApply("rate_change", proposed(), null, null)).toThrow(
      /no longer exists/,
    );
  });

  it("dayBefore handles month and year boundaries", () => {
    expect(dayBefore("2026-08-01")).toBe("2026-07-31");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
  });
});
