import { describe, expect, it } from "vitest";

import { resolveLineParts } from "./line-parts";

const line = (
  id: string,
  lineNumber: number,
  htsCodeDigits: string,
  sku: string | null = null,
  partId: string | null = null,
) => ({ id, lineNumber, sku, partId, htsCodeDigits });

describe("resolveLineParts", () => {
  it("keeps a line's own declared SKU first", () => {
    const resolved = resolveLineParts(
      [line("L1", 1, "7307193040", "EB-MTR-500W", "p1")],
      [{ lineNumber: 1, sku: "eb-mtr-500w", partId: "p1" }],
      [],
    );
    expect(resolved.get("L1")).toEqual([
      { sku: "EB-MTR-500W", partId: "p1", source: "declared" },
    ]);
  });

  it("maps sheet rows to lines by 7501 line number", () => {
    const resolved = resolveLineParts(
      [line("L1", 1, "7307193040"), line("L2", 2, "7307193060")],
      [
        { lineNumber: 1, sku: "0890073182", partId: "p1" },
        { lineNumber: 1, sku: "0890015639", partId: null },
        { lineNumber: 2, sku: "0890071160", partId: "p2" },
        { lineNumber: 9, sku: "GHOST", partId: null },
      ],
      [],
    );
    expect(resolved.get("L1")).toEqual([
      { sku: "0890073182", partId: "p1", source: "sheet" },
      { sku: "0890015639", partId: null, source: "sheet" },
    ]);
    expect(resolved.get("L2")).toEqual([
      { sku: "0890071160", partId: "p2", source: "sheet" },
    ]);
  });

  it("attributes an invoice line only when its HTS prefix matches exactly one entry line", () => {
    const resolved = resolveLineParts(
      [line("L1", 1, "7307193040"), line("L2", 2, "8501314000")],
      [],
      [
        // 6-digit prefix, unique match → attributes.
        { sku: "SKU-A", partId: "pA", htsCodeDigits: "730719" },
        // Unique full-code match.
        { sku: "SKU-B", partId: null, htsCodeDigits: "8501314000" },
        // No HTS on the invoice line and entry has 2 lines → nothing.
        { sku: "SKU-C", partId: "pC", htsCodeDigits: null },
      ],
    );
    expect(resolved.get("L1")).toEqual([
      { sku: "SKU-A", partId: "pA", source: "invoice" },
    ]);
    expect(resolved.get("L2")).toEqual([
      { sku: "SKU-B", partId: null, source: "invoice" },
    ]);
  });

  it("attributes nothing on an ambiguous HTS prefix", () => {
    const resolved = resolveLineParts(
      [line("L1", 1, "7307193040"), line("L2", 2, "7307193060")],
      [],
      [{ sku: "SKU-A", partId: "pA", htsCodeDigits: "730719" }],
    );
    expect(resolved.size).toBe(0);
  });

  it("attributes code-less invoice lines when the entry has exactly one line", () => {
    const resolved = resolveLineParts(
      [line("L1", 1, "7307193040")],
      [],
      [
        { sku: "SKU-A", partId: "pA", htsCodeDigits: null },
        { sku: "SKU-B", partId: null, htsCodeDigits: null },
        { sku: "sku-a", partId: "pA", htsCodeDigits: null }, // case twin dedupes
      ],
    );
    expect(resolved.get("L1")).toEqual([
      { sku: "SKU-A", partId: "pA", source: "invoice" },
      { sku: "SKU-B", partId: null, source: "invoice" },
    ]);
  });

  it("never lets inference add to a sheet-covered line", () => {
    const resolved = resolveLineParts(
      [line("L1", 1, "7307193040")],
      [{ lineNumber: 1, sku: "0890073182", partId: "p1" }],
      [{ sku: "SKU-X", partId: null, htsCodeDigits: "730719" }],
    );
    expect(resolved.get("L1")).toEqual([
      { sku: "0890073182", partId: "p1", source: "sheet" },
    ]);
  });

  it("ignores short HS prefixes (under 6 digits) as too weak to attribute", () => {
    const resolved = resolveLineParts(
      [line("L1", 1, "7307193040"), line("L2", 2, "8501314000")],
      [],
      [{ sku: "SKU-A", partId: null, htsCodeDigits: "7307" }],
    );
    expect(resolved.size).toBe(0);
  });
});
