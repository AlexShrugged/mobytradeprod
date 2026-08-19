import { describe, expect, it } from "vitest";

import {
  ApplyValidationError,
  dayBefore,
  planFamilyExemptionLinks,
  planRevisionApply,
  type FamilyCh99Row,
} from "./apply";
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

// The 232-metals-2026 shape: one exemption heading (9903.82.01, "no
// aluminum/steel content") excusing several liability headings in the family.
function familyRow(over: Partial<FamilyCh99Row> = {}): FamilyCh99Row {
  return {
    id: "01a00000-0000-7000-8000-000000000001",
    code: "9903.82.01",
    codeDigits: "99038201",
    description: "No aluminum or steel content",
    rateType: "ad_valorem",
    exemption: true,
    tradeMeasureId: "m-exempt-1",
    ...over,
  };
}

describe("planFamilyExemptionLinks", () => {
  const exemption = familyRow();
  const liability8202 = familyRow({
    id: "01a00000-0000-7000-8000-000000000002",
    code: "9903.82.02",
    codeDigits: "99038202",
    description: "Articles of aluminum, steel, or copper (50%)",
    exemption: false,
    tradeMeasureId: "m-8202",
  });
  const liability8204 = familyRow({
    id: "01a00000-0000-7000-8000-000000000003",
    code: "9903.82.04",
    codeDigits: "99038204",
    description: "Articles of aluminum, steel, or copper — UK (25%)",
    exemption: false,
    tradeMeasureId: "m-8204",
  });

  it("copies each family exemption under every liability measure", () => {
    const plan = planFamilyExemptionLinks([exemption, liability8202, liability8204]);
    expect(plan).toEqual([
      {
        code: "9903.82.01",
        codeDigits: "99038201",
        description: "No aluminum or steel content",
        rateType: "ad_valorem",
        tradeMeasureId: "m-8202",
      },
      {
        code: "9903.82.01",
        codeDigits: "99038201",
        description: "No aluminum or steel content",
        rateType: "ad_valorem",
        tradeMeasureId: "m-8204",
      },
    ]);
  });

  it("is idempotent: existing (digits, measure) links are never re-planned", () => {
    const alreadyLinked = familyRow({
      id: "01a00000-0000-7000-8000-000000000004",
      tradeMeasureId: "m-8202",
    });
    const plan = planFamilyExemptionLinks([
      exemption,
      alreadyLinked,
      liability8202,
      liability8204,
    ]);
    expect(plan.map((p) => p.tradeMeasureId)).toEqual(["m-8204"]);
  });

  it("plans nothing without liabilities, without exemptions, or for unlinked rows", () => {
    expect(planFamilyExemptionLinks([exemption])).toEqual([]);
    expect(planFamilyExemptionLinks([liability8202, liability8204])).toEqual([]);
    expect(
      planFamilyExemptionLinks([familyRow({ tradeMeasureId: null }), liability8202]),
    ).toEqual([]);
  });

  it("copies metadata from the lowest-id row per exemption digits", () => {
    const later = familyRow({
      id: "01a00000-0000-7000-8000-00000000000f",
      description: "Renamed later copy",
      tradeMeasureId: "m-exempt-2",
    });
    const plan = planFamilyExemptionLinks([later, exemption, liability8202]);
    expect(plan).toHaveLength(1);
    expect(plan[0].description).toBe("No aluminum or steel content");
  });

  it("handles several exemption codes against several liability windows", () => {
    const exemption8203 = familyRow({
      id: "01a00000-0000-7000-8000-000000000005",
      code: "9903.82.03",
      codeDigits: "99038203",
      tradeMeasureId: "m-exempt-3",
    });
    const plan = planFamilyExemptionLinks([
      exemption,
      exemption8203,
      liability8202,
      liability8204,
    ]);
    expect(plan.map((p) => `${p.codeDigits}:${p.tradeMeasureId}`)).toEqual([
      "99038201:m-8202",
      "99038201:m-8204",
      "99038203:m-8202",
      "99038203:m-8204",
    ]);
  });
});
