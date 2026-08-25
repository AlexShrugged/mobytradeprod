import { describe, expect, it } from "vitest";

import { buildSkuIndex, normalizeSku, resolveSku } from "./sku";

describe("normalizeSku", () => {
  it("trims and casefolds", () => {
    expect(normalizeSku("  ab-C12 ")).toBe("AB-C12");
  });

  it("collapses blank to null", () => {
    expect(normalizeSku("")).toBeNull();
    expect(normalizeSku("   ")).toBeNull();
    expect(normalizeSku(null)).toBeNull();
    expect(normalizeSku(undefined)).toBeNull();
  });

  it("keeps interior punctuation and spacing (conservative on purpose)", () => {
    expect(normalizeSku("AB C1")).toBe("AB C1");
    expect(normalizeSku("AB-C1")).not.toBe(normalizeSku("ABC1"));
  });
});

describe("resolveSku", () => {
  const upper = { id: "a", sku: "WIDGET-01" };

  it("matches across casing and padding", () => {
    const index = buildSkuIndex([upper]);
    expect(resolveSku(index, "widget-01")).toBe(upper);
    expect(resolveSku(index, "  Widget-01 ")).toBe(upper);
  });

  it("returns null for unknown or blank SKUs", () => {
    const index = buildSkuIndex([upper]);
    expect(resolveSku(index, "WIDGET-02")).toBeNull();
    expect(resolveSku(index, " ")).toBeNull();
    expect(resolveSku(index, null)).toBeNull();
  });

  it("prefers the exact spelling among case twins", () => {
    const lower = { id: "b", sku: "widget-01" };
    const index = buildSkuIndex([upper, lower]);
    expect(resolveSku(index, "widget-01")).toBe(lower);
    expect(resolveSku(index, " WIDGET-01")).toBe(upper);
  });

  it("refuses to guess between case twins", () => {
    const lower = { id: "b", sku: "widget-01" };
    const index = buildSkuIndex([upper, lower]);
    expect(resolveSku(index, "Widget-01")).toBeNull();
  });
});
