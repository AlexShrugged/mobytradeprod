import { describe, expect, it } from "vitest";

import { diffBaseRelease, prepareBaseRows, runBaseEtl } from "./base-etl";
import type { BaseScheduleRow, CurrentBaseWindow } from "./types";

function row(over: Partial<BaseScheduleRow>): BaseScheduleRow {
  return {
    htsno: "",
    indent: 0,
    description: "",
    general: "",
    special: "",
    other: "",
    unitOfQuantity: "",
    ...over,
  };
}

// A realistic chapter-1 slice: heading, codeless decision branch, rated
// subheading, and blank-rate statistical suffixes.
const HORSES: BaseScheduleRow[] = [
  row({ htsno: "0101", indent: 0, description: "Live horses, asses, mules" }),
  row({ htsno: "", indent: 1, description: "Horses:" }), // codeless branch
  row({
    htsno: "0101.21.00",
    indent: 2,
    description: "Purebred breeding animals",
    general: "Free",
    other: "Free",
  }),
  row({ htsno: "0101.21.00.10", indent: 3, description: "Males", unitOfQuantity: "No." }),
  row({ htsno: "0101.21.00.20", indent: 3, description: "Females", unitOfQuantity: "No." }),
  row({
    htsno: "0101.29.00",
    indent: 2,
    description: "Other",
    general: "4.5%",
    special: "Free (A+,AU,BH)",
    other: "20%",
  }),
  row({ htsno: "0101.29.00.10", indent: 3, description: "Imported for immediate slaughter" }),
  row({ htsno: "0101.30.00.00", indent: 1, description: "Asses", general: "6.8%" }),
];

describe("prepareBaseRows hierarchy recovery", () => {
  const prepared = prepareBaseRows(HORSES);
  const byDigits = new Map(prepared.map((p) => [p.codeDigits, p]));

  it("emits only coded rows — codeless decision branches never become rows", () => {
    expect(prepared).toHaveLength(7);
    expect(prepared.every((p) => p.code !== "")).toBe(true);
  });

  it("parent is the nearest CODED ancestor, skipping codeless branches", () => {
    // 0101.21.00 sits under the codeless "Horses:" row; its parent must be
    // the 0101 heading, not the branch.
    expect(byDigits.get("01012100")?.parentDigits).toBe("0101");
    expect(byDigits.get("0101210010")?.parentDigits).toBe("01012100");
    expect(byDigits.get("01012900")?.parentDigits).toBe("0101");
  });

  it("outdenting pops the stack back to the right ancestor", () => {
    // 0101.30.00.00 (indent 1) follows indent-3 rows; it belongs to 0101.
    expect(byDigits.get("0101300000")?.parentDigits).toBe("0101");
  });

  it("blank-rate rows inherit from the nearest rate-bearing ancestor", () => {
    const male = byDigits.get("0101210010")!;
    expect(male.rate).toBe(0);
    expect(male.rateType).toBe("free");
    expect(male.rateInheritedFrom).toBe("01012100");
    expect(male.col1General).toBe("Free");

    const slaughter = byDigits.get("0101290010")!;
    expect(slaughter.rate).toBe(0.045);
    expect(slaughter.rateType).toBe("ad_valorem");
    expect(slaughter.rateInheritedFrom).toBe("01012900");
    expect(slaughter.col1General).toBe("4.5%");
  });

  it("rows with their own rate cells never record inheritance", () => {
    const sub = byDigits.get("01012900")!;
    expect(sub.rate).toBe(0.045);
    expect(sub.rateInheritedFrom).toBeNull();
    expect(sub.col1Special).toBe("Free (A+,AU,BH)");
    expect(sub.col2Rate).toBe("20%");
  });

  it("a heading with no rate anywhere is display-only (rate null, other)", () => {
    const heading = byDigits.get("0101")!;
    expect(heading.rate).toBeNull();
    expect(heading.rateType).toBe("other");
    expect(heading.col1General).toBeNull();
    expect(heading.rateInheritedFrom).toBeNull();
  });

  it("keeps chapters 1–97 only", () => {
    const prepared98 = prepareBaseRows([
      ...HORSES,
      row({ htsno: "9817.00.96", indent: 0, description: "Articles for the handicapped", general: "Free" }),
      row({ htsno: "9903.01.23", indent: 0, description: "IEEPA measure line", general: "25%" }),
    ]);
    expect(prepared98.some((p) => p.chapter > 97)).toBe(false);
    expect(prepared98).toHaveLength(7);
  });

  it("a sibling at the same indent replaces its predecessor on the stack", () => {
    const prepared2 = prepareBaseRows([
      row({ htsno: "0201", indent: 0, description: "Meat of bovine animals" }),
      row({ htsno: "0201.10.05", indent: 1, description: "Described in note 3", general: "4.4¢/kg" }),
      row({ htsno: "0201.10.10", indent: 1, description: "Other", general: "26.4%" }),
      row({ htsno: "0201.10.10.10", indent: 2, description: "Veal" }),
    ]);
    const veal = prepared2.find((p) => p.codeDigits === "0201101010")!;
    // Parent and rate come from the SECOND sibling, not the first.
    expect(veal.parentDigits).toBe("02011010");
    expect(veal.rateInheritedFrom).toBe("02011010");
    expect(veal.rate).toBe(0.264);
    // The specific-rate sibling parses as non-computable but valid.
    const note3 = prepared2.find((p) => p.codeDigits === "02011005")!;
    expect(note3.rateType).toBe("specific");
    expect(note3.rate).toBeNull();
  });

  it("a codeless branch carrying rate cells can still be the rate ancestor", () => {
    const prepared3 = prepareBaseRows([
      row({ htsno: "0301", indent: 0, description: "Live fish" }),
      row({ htsno: "", indent: 1, description: "Other:", general: "2%" }),
      row({ htsno: "0301.99.03.00", indent: 2, description: "Other" }),
    ]);
    const leaf = prepared3.find((p) => p.codeDigits === "0301990300")!;
    expect(leaf.rate).toBe(0.02);
    // The ancestor was codeless, so there is no digits to point at.
    expect(leaf.rateInheritedFrom).toBeNull();
    expect(leaf.parentDigits).toBe("0301");
  });

  it("duplicate codes keep the last occurrence (upsert semantics)", () => {
    const prepared4 = prepareBaseRows([
      row({ htsno: "0101.21.00", indent: 0, description: "First", general: "Free" }),
      row({ htsno: "0101.21.00", indent: 0, description: "Second", general: "2%" }),
    ]);
    expect(prepared4).toHaveLength(1);
    expect(prepared4[0].description).toBe("Second");
    expect(prepared4[0].rate).toBe(0.02);
  });
});

describe("diffBaseRelease", () => {
  const current: CurrentBaseWindow[] = [
    {
      codeDigits: "01012100",
      code: "0101.21.00",
      description: "Purebred breeding animals",
      rate: 0,
      validFrom: "2025-01-01",
      release: "2026HTSRev1",
    },
    {
      codeDigits: "01012900",
      code: "0101.29.00",
      description: "Other",
      rate: 0.045,
      validFrom: "2025-01-01",
      release: "2026HTSRev1",
    },
    {
      codeDigits: "01019030",
      code: "0101.90.30",
      description: "Imported for immediate slaughter",
      rate: 0,
      validFrom: "2025-01-01",
      release: "2026HTSRev1",
    },
  ];

  it("classifies added, changed (rate), removed, unchanged", () => {
    const release = [
      row({ htsno: "0101.21.00", indent: 0, description: "Purebred breeding animals", general: "Free" }),
      row({ htsno: "0101.29.00", indent: 0, description: "Other", general: "6%" }), // rate 4.5% -> 6%
      row({ htsno: "0101.30.00", indent: 0, description: "Asses", general: "6.8%" }), // new
      // 0101.90.30 absent -> removed
    ];
    const { diff } = runBaseEtl(release, current);
    expect(diff.added.map((a) => a.codeDigits)).toEqual(["01013000"]);
    expect(diff.changed.map((c) => c.row.codeDigits)).toEqual(["01012900"]);
    expect(diff.changed[0].current.rate).toBe(0.045);
    expect(diff.removed.map((r) => r.codeDigits)).toEqual(["01019030"]);
    expect(diff.unchanged).toBe(1);
  });

  it("description drift is a change; whitespace-only drift is not", () => {
    const prepared = prepareBaseRows([
      row({ htsno: "0101.21.00", indent: 0, description: "Purebred  breeding\tanimals", general: "Free" }),
      row({ htsno: "0101.29.00", indent: 0, description: "Other (updated wording)", general: "4.5%" }),
      row({ htsno: "0101.90.30", indent: 0, description: "Imported for immediate slaughter", general: "Free" }),
    ]);
    const diff = diffBaseRelease(prepared, current);
    // Collapsed whitespace matches -> unchanged; real wording drift -> changed.
    expect(diff.changed.map((c) => c.row.codeDigits)).toEqual(["01012900"]);
    expect(diff.unchanged).toBe(2);
  });

  it("a computable rate appearing or vanishing counts as a change", () => {
    const prepared = prepareBaseRows([
      // Was 0 (Free), now specific (null): changed.
      row({ htsno: "0101.21.00", indent: 0, description: "Purebred breeding animals", general: "5¢/kg" }),
      row({ htsno: "0101.29.00", indent: 0, description: "Other", general: "4.5%" }),
      row({ htsno: "0101.90.30", indent: 0, description: "Imported for immediate slaughter", general: "Free" }),
    ]);
    const diff = diffBaseRelease(prepared, current);
    expect(diff.changed.map((c) => c.row.codeDigits)).toEqual(["01012100"]);
  });

  it("a reappearing code (only closed windows live elsewhere) lands in added", () => {
    // Current windows only ever contain OPEN windows, so a code whose
    // window was closed simply isn't here — the release row is "added" and
    // base-apply opens a fresh window.
    const prepared = prepareBaseRows([
      row({ htsno: "0101.21.00", indent: 0, description: "Purebred breeding animals", general: "Free" }),
    ]);
    const diff = diffBaseRelease(prepared, []);
    expect(diff.added.map((a) => a.codeDigits)).toEqual(["01012100"]);
    expect(diff.removed).toEqual([]);
  });
});
