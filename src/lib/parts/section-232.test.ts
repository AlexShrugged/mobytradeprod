import { describe, expect, it } from "vitest";

import {
  isExemptionHeader,
  isSection232Header,
  parseSection232Cell,
  section232Mark,
  section232ToCell,
} from "./section-232";

describe("isSection232Header", () => {
  it("finds 232 as a number of its own", () => {
    for (const h of [
      "232",
      "Section 232",
      "Sec. 232?",
      "section_232",
      "Steel Hardware for Section 232",
      "232 Exempt",
      "S232 Applies",
    ]) {
      expect(isSection232Header(h), h).toBe(true);
    }
  });

  it("ignores digits inside a longer number and unrelated headers", () => {
    for (const h of ["Item 12320", "SKU 2325", "HTS Code", "Section 301"]) {
      expect(isSection232Header(h), h).toBe(false);
    }
  });
});

describe("isExemptionHeader", () => {
  it("reads exemption phrasing as the flipped column", () => {
    for (const h of [
      "Section 232 Exempt",
      "232 Exemption",
      "Exempt from 232",
      "232 Exclusion",
      "Excluded from Section 232",
      "Not Subject to 232",
    ]) {
      expect(isExemptionHeader(h), h).toBe(true);
    }
    expect(isExemptionHeader("Section 232")).toBe(false);
    expect(isExemptionHeader("Steel Hardware for Section 232")).toBe(false);
  });
});

describe("parseSection232Cell", () => {
  const value = (header: string, cell: string | null) => {
    const r = parseSection232Cell(header, cell);
    if (!r.ok) throw new Error(r.problem);
    return r.value;
  };

  it("reads Yes as applies under a plain header", () => {
    expect(value("Section 232", "Yes")).toBe(true);
    expect(value("Steel Hardware for Section 232", "yes")).toBe(true);
    expect(value("232", "Y")).toBe(true);
    expect(value("232", "TRUE")).toBe(true);
    expect(value("232", "1")).toBe(true);
    expect(value("232", "X")).toBe(true);
    expect(value("Section 232", "No")).toBe(false);
    expect(value("Section 232", "n")).toBe(false);
    expect(value("Section 232", "0")).toBe(false);
  });

  it("flips Yes and No under an exemption header", () => {
    expect(value("Section 232 Exempt", "Yes")).toBe(false);
    expect(value("232 Exemption", "No")).toBe(true);
    expect(value("Excluded from Section 232", "Y")).toBe(false);
  });

  it("lets a cell that says the answer in words beat the header", () => {
    expect(value("Section 232", "Exempt")).toBe(false);
    expect(value("Section 232", "Excluded")).toBe(false);
    expect(value("Section 232", "Not subject")).toBe(false);
    expect(value("Section 232", "Does not apply")).toBe(false);
    expect(value("Section 232", "Applies")).toBe(true);
    expect(value("232 Exempt", "Subject")).toBe(true);
    expect(value("232 Exempt", "Exempt")).toBe(false);
  });

  it("reads Not applicable with the header it answers", () => {
    expect(value("Section 232", "Not applicable")).toBe(false);
    expect(value("Section 232", "None")).toBe(false);
    expect(value("232 Exempt", "Not applicable")).toBeNull();
  });

  it("reads blank and N/A as not specified, never as No", () => {
    expect(value("Section 232", null)).toBeNull();
    expect(value("Section 232", "  ")).toBeNull();
    expect(value("Section 232", "N/A")).toBeNull();
    expect(value("232 Exempt", "n/a")).toBeNull();
  });

  it("reports a value it cannot read", () => {
    const r = parseSection232Cell("Section 232", "50%");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain('"50%"');
  });
});

describe("vocabulary", () => {
  it("round-trips the export cell through the parser", () => {
    for (const v of [true, false, null]) {
      const r = parseSection232Cell("Section 232", section232ToCell(v));
      expect(r).toEqual({ ok: true, value: v });
    }
  });

  it("keeps not-specified null for the analyst", () => {
    expect(section232Mark(true)).toBe("applies");
    expect(section232Mark(false)).toBe("does_not_apply");
    expect(section232Mark(null)).toBeNull();
  });
});
