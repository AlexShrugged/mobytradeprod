import { describe, expect, it } from "vitest";

import { normalizeVendorName } from "./normalize";

describe("normalizeVendorName", () => {
  it("trims and casefolds", () => {
    expect(normalizeVendorName("  Shenzhen Volt Dynamics ")).toBe(
      "shenzhen volt dynamics",
    );
  });

  it("collapses empty and whitespace-only names to null", () => {
    expect(normalizeVendorName("")).toBeNull();
    expect(normalizeVendorName("   ")).toBeNull();
    expect(normalizeVendorName(null)).toBeNull();
    expect(normalizeVendorName(undefined)).toBeNull();
  });

  it("does NOT strip legal suffixes — distinct names stay distinct", () => {
    expect(normalizeVendorName("Shenzhen Volt Dynamics Co.")).not.toBe(
      normalizeVendorName("Shenzhen Volt Dynamics"),
    );
  });

  it("matches names differing only in case", () => {
    expect(normalizeVendorName("HANOI PRECISION COMPONENTS")).toBe(
      normalizeVendorName("Hanoi Precision Components"),
    );
  });
});
