import { describe, expect, it } from "vitest";

import { findSailClauses } from "./sail-clauses";

// The real 9903.01.23 IEEPA on-the-water clause, verbatim from the USITC
// 2025 HTS export — the canonical fixture this highlighter exists for.
const IEEPA_9903_01_23 =
  "Except for products described in headings 9903.01.21 and 9903.01.22, " +
  "and other than products for personal use included in accompanied baggage " +
  "of persons arriving in the United States, articles the product of China " +
  "and Hong Kong that: (1) were loaded onto a vessel at the port of " +
  "loading, or in transit on the final mode of transport prior to entry " +
  "into the United States, before 12:01 a.m. eastern standard time on " +
  "February 1, 2025; and (2) are entered for consumption, or withdrawn " +
  "from warehouse for consumption, on or after 12:01 a.m. eastern standard " +
  "time on February 4, 2025, and before 12:01 a.m. eastern standard time " +
  "on March 7, 2025.";

describe("findSailClauses", () => {
  it("extracts all three conditions from the verbatim 9903.01.23 text", () => {
    const found = findSailClauses(IEEPA_9903_01_23);
    expect(found.map((c) => [c.kind, c.isoDate])).toEqual([
      ["sail_before", "2025-02-01"],
      ["entry_on_or_after", "2025-02-04"],
      ["entry_before", "2025-03-07"],
    ]);
    for (const c of found) {
      expect(c.snippet).toContain(
        `${c.isoDate.slice(0, 4)}`, // snippet carries the year of its date
      );
    }
  });

  it("classifies laden-aboard phrasing as a sail cue", () => {
    const found = findSailClauses(
      "goods laden aboard a vessel before August 1, 2026 are exempt",
    );
    expect(found.map((c) => [c.kind, c.isoDate])).toEqual([
      ["sail_before", "2026-08-01"],
    ]);
  });

  it("returns nothing for text without qualifying clauses", () => {
    expect(findSailClauses("Articles of aluminum, of heading 7604")).toEqual([]);
    expect(
      // A date with no sail/entry cue anywhere near it.
      findSailClauses("As announced on February 1, 2025, rates may change."),
    ).toEqual([]);
  });
});
