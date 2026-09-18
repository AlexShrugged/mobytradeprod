import { describe, expect, it } from "vitest";

import {
  formatQuantity,
  normalizeQuantityUnit,
  parseHtsReportingUnits,
  quantityUnitLabel,
  resolveEntryLineUnit,
  resolveInvoiceLineUnit,
} from "./quantity-unit";

describe("normalizeQuantityUnit", () => {
  it("maps 7501 ABI codes to families", () => {
    expect(normalizeQuantityUnit("KG")).toBe("kg");
    expect(normalizeQuantityUnit("NO")).toBe("no");
    expect(normalizeQuantityUnit("PCS")).toBe("no");
    expect(normalizeQuantityUnit("DOZ")).toBe("doz");
    expect(normalizeQuantityUnit("PRS")).toBe("prs");
    expect(normalizeQuantityUnit("M2")).toBe("m2");
    expect(normalizeQuantityUnit("X")).toBe("x");
  });

  it("maps invoice spellings, plurals, and punctuation", () => {
    expect(normalizeQuantityUnit("pcs.")).toBe("no");
    expect(normalizeQuantityUnit("Pieces")).toBe("no");
    expect(normalizeQuantityUnit("EA")).toBe("no");
    expect(normalizeQuantityUnit("units")).toBe("no");
    expect(normalizeQuantityUnit("KGS")).toBe("kg");
    expect(normalizeQuantityUnit("Kilograms")).toBe("kg");
    expect(normalizeQuantityUnit("SETS")).toBe("set");
    expect(normalizeQuantityUnit("pairs")).toBe("prs");
    expect(normalizeQuantityUnit("PCS (EA)")).toBe("no");
    expect(normalizeQuantityUnit("KG/NET")).toBe("kg");
  });

  it("maps USITC schedule spellings", () => {
    expect(normalizeQuantityUnit("No.")).toBe("no");
    expect(normalizeQuantityUnit("doz.")).toBe("doz");
    expect(normalizeQuantityUnit("prs.")).toBe("prs");
    expect(normalizeQuantityUnit("doz. prs.")).toBe("dpr");
    expect(normalizeQuantityUnit("m²")).toBe("m2");
    expect(normalizeQuantityUnit("kg cmsc")).toBe("kg");
    expect(normalizeQuantityUnit("liters")).toBe("l");
    expect(normalizeQuantityUnit("t")).toBe("t");
  });

  it("returns null for unknown or empty spellings — unknown never compares", () => {
    expect(normalizeQuantityUnit(null)).toBeNull();
    expect(normalizeQuantityUnit("")).toBeNull();
    expect(normalizeQuantityUnit("  ")).toBeNull();
    expect(normalizeQuantityUnit("CTN")).toBeNull();
    expect(normalizeQuantityUnit("boxes")).toBeNull();
  });
});

describe("parseHtsReportingUnits", () => {
  it("splits two-unit codes and dedupes families", () => {
    expect(parseHtsReportingUnits("No., kg")).toEqual(["no", "kg"]);
    expect(parseHtsReportingUnits("doz., kg")).toEqual(["doz", "kg"]);
    expect(parseHtsReportingUnits("kg, kg cmsc")).toEqual(["kg"]);
    expect(parseHtsReportingUnits("kg")).toEqual(["kg"]);
    expect(parseHtsReportingUnits(null)).toEqual([]);
  });
});

describe("resolveEntryLineUnit", () => {
  it("prefers the printed code over the schedule", () => {
    expect(resolveEntryLineUnit("KG", "No.")).toBe("kg");
  });

  it("falls back to a single-unit reporting unit — column 32 is HTSUS units by definition", () => {
    expect(resolveEntryLineUnit(null, "kg")).toBe("kg");
    expect(resolveEntryLineUnit(undefined, "No.")).toBe("no");
  });

  it("stays unknown on a two-unit code without a printed code", () => {
    expect(resolveEntryLineUnit(null, "No., kg")).toBeNull();
  });

  it("treats X (no quantity required) as no comparable quantity", () => {
    expect(resolveEntryLineUnit("X", "kg")).toBeNull();
    expect(resolveEntryLineUnit(null, "X")).toBeNull();
  });

  it("stays unknown when nothing names a unit", () => {
    expect(resolveEntryLineUnit(null, null)).toBeNull();
    expect(resolveEntryLineUnit("CTN", null)).toBeNull();
  });
});

describe("resolveInvoiceLineUnit", () => {
  it("reads only what the invoice prints", () => {
    expect(resolveInvoiceLineUnit("PCS")).toBe("no");
    expect(resolveInvoiceLineUnit(null)).toBeNull();
    expect(resolveInvoiceLineUnit("X")).toBeNull();
  });
});

describe("display", () => {
  it("labels families and formats quantities", () => {
    expect(quantityUnitLabel("no")).toBe("pcs");
    expect(quantityUnitLabel("m2")).toBe("m²");
    expect(quantityUnitLabel(null)).toBe("");
    expect(formatQuantity(1065, "kg")).toBe("1,065 kg");
    expect(formatQuantity("1500.0000", "no")).toBe("1,500 pcs");
    expect(formatQuantity(12.5, null)).toBe("12.5");
    expect(formatQuantity(null, "kg")).toBe("—");
  });
});
