import { describe, expect, it } from "vitest";

import {
  findProgramConflicts,
  findSailPartitioned,
  inferProgram,
  planProgramResolution,
  type LiveProgramMeasure,
} from "./programs";
import type { ProposedMeasureChange } from "./types";

describe("inferProgram", () => {
  it("maps single-action authorities directly", () => {
    expect(inferProgram("section_232_steel", "9903.81.87", "Steel articles")).toBe(
      "section-232-steel",
    );
    expect(inferProgram("section_122", "9903.03.01", "Import surcharge")).toBe(
      "section-122",
    );
    expect(
      inferProgram("reciprocal", "9903.02.05", "Articles the product of Brazil"),
    ).toBe("ieepa-reciprocal");
  });

  it("splits the IEEPA statute into its distinct programs", () => {
    expect(
      inferProgram(
        "ieepa",
        "9903.01.24",
        "Articles the product of China addressing the synthetic opioid supply chain",
      ),
    ).toBe("ieepa-fentanyl");
    expect(
      inferProgram("ieepa", "9903.01.10", "Articles the product of Canada"),
    ).toBe("ieepa-border-canada");
    expect(
      inferProgram("ieepa", "9903.01.01", "Articles the product of Mexico"),
    ).toBe("ieepa-border-mexico");
    // The 9903.01.20–.24 block is the China/HK opioid program even when the
    // prose only names the country.
    expect(
      inferProgram("ieepa", "9903.01.20", "Articles the product of China and Hong Kong"),
    ).toBe("ieepa-fentanyl");
  });

  it("returns null rather than guess", () => {
    expect(inferProgram("ieepa", "9903.01.90", "Articles subject to duties")).toBeNull();
    expect(inferProgram("other", "9903.99.01", "Miscellaneous")).toBeNull();
    expect(
      inferProgram("section_301", "9903.94.05", "Articles of certain economies"),
    ).toBeNull();
  });

  it("distinguishes Section 301 investigations", () => {
    expect(
      inferProgram("section_301", "9903.88.03", "Articles of China, List 3"),
    ).toBe("section-301-china");
    expect(
      inferProgram(
        "section_301",
        "9903.94.10",
        "Articles of economies failing to prohibit goods produced with forced labor",
      ),
    ).toBe("section-301-forced-labor");
  });
});

function liveMeasure(over: Partial<LiveProgramMeasure>): LiveProgramMeasure {
  return {
    id: "live-1",
    name: "IEEPA Reciprocal — baseline",
    ch99Code: "9903.01.25",
    program: "ieepa-reciprocal",
    countries: null,
    effectiveDate: "2025-04-05",
    endDate: null,
    scope: "all_products",
    prefixes: [],
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    ...over,
  };
}

function proposal(
  over: Partial<ProposedMeasureChange>,
): Pick<
  ProposedMeasureChange,
  | "program"
  | "countries"
  | "effectiveDate"
  | "endDate"
  | "scope"
  | "prefixes"
  | "exemption"
  | "sailedOnOrAfter"
  | "sailedOnOrBefore"
> {
  return {
    program: "ieepa-reciprocal",
    countries: ["CN"],
    effectiveDate: "2026-08-07",
    endDate: null,
    scope: "all_products",
    prefixes: [],
    exemption: false,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    ...over,
  };
}

describe("findProgramConflicts", () => {
  it("worldwide baseline vs country-specific heading coexists by design", () => {
    // The published shape: 9903.01.25 alongside per-country headings. The
    // calculator resolves per line; the write side must not block it.
    expect(
      findProgramConflicts(proposal({}), [liveMeasure({})]),
    ).toEqual([]);
  });

  it("flags same-tier overlaps: intersecting country lists", () => {
    const cn34 = liveMeasure({
      id: "cn34",
      name: "IEEPA Reciprocal — China",
      ch99Code: "9903.01.63",
      countries: ["CN"],
      effectiveDate: "2025-04-09",
    });
    expect(findProgramConflicts(proposal({}), [cn34]).map((c) => c.id)).toEqual([
      "cn34",
    ]);
    // Disjoint countries — the per-country family pattern — never conflict.
    expect(
      findProgramConflicts(proposal({ countries: ["VN"] }), [cn34]),
    ).toEqual([]);
  });

  it("flags worldwide vs worldwide", () => {
    expect(
      findProgramConflicts(proposal({ countries: null }), [liveMeasure({})]).map(
        (c) => c.id,
      ),
    ).toEqual(["live-1"]);
  });

  it("respects windows, program identity, product scope, and exemptions", () => {
    const ended = liveMeasure({ id: "ended", endDate: "2026-02-24" });
    expect(findProgramConflicts(proposal({ countries: null }), [ended])).toEqual([]);

    const otherProgram = liveMeasure({ id: "fent", program: "ieepa-fentanyl" });
    expect(
      findProgramConflicts(proposal({ countries: null }), [otherProgram]),
    ).toEqual([]);

    const steelList = liveMeasure({
      id: "steel",
      program: "section-232-steel",
      scope: "hts_list",
      prefixes: ["7307"],
    });
    expect(
      findProgramConflicts(
        proposal({
          program: "section-232-steel",
          countries: null,
          scope: "hts_list",
          prefixes: ["8501"],
        }),
        [steelList],
      ),
    ).toEqual([]);
    // Nested prefixes intersect ("73" covers "7307").
    expect(
      findProgramConflicts(
        proposal({
          program: "section-232-steel",
          countries: null,
          scope: "hts_list",
          prefixes: ["73"],
        }),
        [steelList],
      ).map((c) => c.id),
    ).toEqual(["steel"]);

    expect(
      findProgramConflicts(proposal({ countries: null, exemption: true }), [
        liveMeasure({}),
      ]),
    ).toEqual([]);
    expect(
      findProgramConflicts(proposal({ countries: null, program: null }), [
        liveMeasure({}),
      ]),
    ).toEqual([]);
  });

  it("a null effective date counts as overlapping (pre-review note)", () => {
    // Before the reviewer confirms dates the window is unsettled — the
    // review card must still disclose what an overlapping window would
    // supersede.
    expect(
      findProgramConflicts(proposal({ countries: null, effectiveDate: null }), [
        liveMeasure({}),
      ]).map((c) => c.id),
    ).toEqual(["live-1"]);
    // A closed live window is still not a conflict for a dated proposal.
    expect(
      findProgramConflicts(proposal({ countries: null }), [
        liveMeasure({ endDate: "2026-02-24" }),
      ]),
    ).toEqual([]);
  });

  it("disjoint sail windows partition the pair instead of conflicting", () => {
    // The on-the-water cutover: old rate for goods laden through 6/15, new
    // rate for goods laden 6/16 on. A sail-date supersession the window
    // model represents as two simultaneously live measures.
    const onTheWater = liveMeasure({
      id: "old-rate",
      countries: null,
      sailedOnOrBefore: "2026-06-15",
    });
    const newRate = proposal({
      countries: null,
      sailedOnOrAfter: "2026-06-16",
    });
    expect(findProgramConflicts(newRate, [onTheWater])).toEqual([]);
    expect(findSailPartitioned(newRate, [onTheWater]).map((c) => c.id)).toEqual(
      ["old-rate"],
    );

    // Sail windows that SHARE a lading date do conflict: both claim goods
    // laden on 6/15.
    const overlappingSail = proposal({
      countries: null,
      sailedOnOrAfter: "2026-06-15",
    });
    expect(
      findProgramConflicts(overlappingSail, [onTheWater]).map((c) => c.id),
    ).toEqual(["old-rate"]);
    expect(findSailPartitioned(overlappingSail, [onTheWater])).toEqual([]);

    // No sail condition on either side = no partition to rely on.
    expect(
      findProgramConflicts(proposal({ countries: null }), [
        liveMeasure({}),
      ]).map((c) => c.id),
    ).toEqual(["live-1"]);
  });
});

describe("planProgramResolution", () => {
  const conflict = liveMeasure({
    id: "cn34",
    name: "IEEPA Reciprocal — China",
    ch99Code: "9903.01.63",
    countries: ["CN"],
    effectiveDate: "2025-04-09",
  });

  it("proceeds with no conflicts", () => {
    expect(planProgramResolution(proposal({}), [])).toEqual({ kind: "proceed" });
  });

  it("supersedes automatically: closes the conflicts, links the latest as predecessor", () => {
    const earlier = liveMeasure({
      id: "old-baseline",
      countries: ["CN"],
      effectiveDate: "2025-02-04",
    });
    const res = planProgramResolution(proposal({}), [earlier, conflict]);
    expect(res).toEqual({
      kind: "supersede",
      closeMeasureIds: ["old-baseline", "cn34"],
      predecessorId: "cn34",
    });
  });

  it("fails closed on conflicts that start on or after the successor", () => {
    const later = liveMeasure({
      id: "later",
      ch99Code: "9903.01.64",
      countries: ["CN"],
      effectiveDate: "2026-08-07",
    });
    const res = planProgramResolution(proposal({}), [later]);
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toContain("9903.01.64");
    }
  });
});
