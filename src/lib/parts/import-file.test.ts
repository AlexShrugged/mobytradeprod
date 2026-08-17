import { describe, expect, it } from "vitest";

import {
  extractCatalogItems,
  extractFromSheets,
  mapHeaders,
  parseCsv,
  toCsv,
  toCsvCell,
} from "./import-file";

describe("parseCsv", () => {
  it("parses quoted fields with embedded commas, quotes, and newlines", () => {
    const rows = parseCsv(
      'sku,description\nEB-1,"Fork, front ""alloy""\n700c"\r\nEB-2,plain\n',
    );
    expect(rows).toEqual([
      ["sku", "description"],
      ["EB-1", 'Fork, front "alloy"\n700c'],
      ["EB-2", "plain"],
    ]);
  });

  it("strips a UTF-8 BOM and keeps blank rows in place", () => {
    const rows = parseCsv("﻿sku\nEB-1\n,,\n\n");
    expect(rows).toEqual([["sku"], ["EB-1"], ["", "", ""], [""]]);
  });

  it("handles CR-only line endings and a missing trailing newline", () => {
    expect(parseCsv("sku\rEB-1")).toEqual([["sku"], ["EB-1"]]);
  });
});

describe("toCsvCell / toCsv", () => {
  it("quotes only when needed and escapes quotes", () => {
    expect(toCsvCell("plain")).toBe("plain");
    expect(toCsvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(toCsvCell(null)).toBe("");
  });

  it("neutralizes formula-leading cells", () => {
    expect(toCsvCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(toCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("round-trips the formula guard through the import cleaner", () => {
    const csv = toCsv([["sku"], ["=EB-1"]]);
    const { items } = extractCatalogItems(parseCsv(csv));
    expect(items).toEqual([expect.objectContaining({ sku: "=EB-1" })]);
  });
});

describe("mapHeaders", () => {
  it("matches synonyms case- and punctuation-insensitively", () => {
    const map = mapHeaders([
      "Part Number",
      "Product Name",
      "HTS-Code",
      "Supplier",
      "Country of Origin",
      "Unit Cost (USD)",
      "UOM",
    ]);
    expect(map).toEqual({
      sku: 0,
      name: 1,
      htsCode: 2,
      vendorName: 3,
      countryOfOrigin: 4,
      unitCost: 5,
      unitOfMeasure: 6,
    });
  });

  it("never maps two fields to one column", () => {
    // "Item" is a sku synonym; the name field must not claim it too.
    const map = mapHeaders(["Item", "Cost"]);
    expect(map).toEqual({ sku: 0, unitCost: 1 });
  });

  it("maps Item Number, Supplier, CTR, and Country", () => {
    expect(mapHeaders(["Item Number", "Supplier", "CTR"])).toEqual({
      sku: 0,
      vendorName: 1,
      countryOfOrigin: 2,
    });
    expect(mapHeaders(["Item", "Vendor", "Country"])).toEqual({
      sku: 0,
      vendorName: 1,
      countryOfOrigin: 2,
    });
  });

  it("matches HTS anywhere in a header once exact synonyms miss", () => {
    expect(mapHeaders(["SKU", "US HTS Classification"])).toEqual({
      sku: 0,
      htsCode: 1,
    });
    expect(mapHeaders(["SKU", "HTS No. (10-digit)"])).toEqual({
      sku: 0,
      htsCode: 1,
    });
  });

  it("maps ERP headers with table-code suffixes (Infor M3 export)", () => {
    // The real headers from a customer file: prefix matching must find the
    // item number, prefer the supplier NAME over the supplier code column,
    // and leave the assist-component and duty-element columns unmapped.
    const map = mapHeaders([
      "Whs  MITBAL MMS002",
      "Supplier MITBAL MMS002",
      "Supplier name  CIDMAS CRS620",
      "Incoterms Dtm",
      "ACD (MAN/DIST/PUR)  MITBAL MMS002",
      "P.G. MITMAS MMS001",
      "FIGURE NUM MITMAS MMS001",
      "Item number MITBAL MMS002",
      "Description 2 MITMAS MMS001",
      "CUS STAT NUM HTS MITFAC MMS003",
      "CTR COUNTRY OF ORIGIN APGRL 123",
      "Most Recent Agreement APGRL 123",
      "Elemnt MPCOVE DDUTY PPS280",
      "Assist Component SKU",
      "Assist Component Price",
    ]);
    expect(map).toEqual({
      sku: 7,
      description: 8,
      htsCode: 9,
      vendorName: 2,
      countryOfOrigin: 10,
    });
  });

  it("never claims columns via over-generic prefixes", () => {
    // "Part Notes" / "Unit Weight" / "Mfg Date" must stay unmapped even
    // though "part", "unit", and "mfg" are exact synonyms.
    expect(mapHeaders(["Part Notes", "Unit Weight", "Mfg Date"])).toEqual({});
  });

  it("prefers an exact HTS synonym over a substring match", () => {
    // "HTS Description" also contains "hts" but the exact "HTS" column wins;
    // the substring pass never claims a second column for the same field.
    expect(mapHeaders(["SKU", "HTS Description", "HTS"])).toEqual({
      sku: 0,
      htsCode: 2,
    });
  });
});

const HEADER = "SKU,Name,Description,HTS Code,Vendor,Origin,Cost,UOM";

describe("extractCatalogItems", () => {
  it("extracts and normalizes a full row", () => {
    const { items, issues } = extractCatalogItems(
      parseCsv(
        `${HEADER}\nEB-100,Front Fork,Alloy 700c,8714.91.3000,Shenzhen Co,cn,"$1,234.50",EA`,
      ),
    );
    expect(issues).toEqual([]);
    expect(items).toEqual([
      {
        sku: "EB-100",
        name: "Front Fork",
        description: "Alloy 700c",
        htsCode: "8714.91.3000",
        unitOfMeasure: "EA",
        sources: [
          {
            vendorName: "Shenzhen Co",
            countryOfOrigin: "CN",
            unitCost: "1234.5000",
          },
        ],
      },
    ]);
  });

  it("skips the preamble above the real header row", () => {
    const { items } = extractCatalogItems(
      parseCsv(`Catalog export,\nas of 2026-08-01,\nSKU,Name\nEB-1,Fork`),
    );
    expect(items).toEqual([expect.objectContaining({ sku: "EB-1" })]);
  });

  it("merges repeated SKUs last-write-wins and collects multi-vendor sources", () => {
    const { items } = extractCatalogItems(
      parseCsv(
        `${HEADER}\nEB-1,Old Name,,8714.91.3000,Vendor A,CN,10,\nEB-1,New Name,,,Vendor B,VN,12,\nEB-1,,,,vendor a,,11,`,
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("New Name");
    expect(items[0].htsCode).toBe("8714.91.3000");
    expect(items[0].sources).toEqual([
      { vendorName: "Vendor A", countryOfOrigin: "CN", unitCost: "11.0000" },
      { vendorName: "Vendor B", countryOfOrigin: "VN", unitCost: "12.0000" },
    ]);
  });

  it("reports bad fields as row issues without dropping the row", () => {
    const { items, issues } = extractCatalogItems(
      parseCsv(
        `${HEADER}\nEB-1,Fork,,9903.88.15,Vendor A,China,free,EA\n,No Sku,,,,,,`,
      ),
    );
    expect(items).toEqual([
      {
        sku: "EB-1",
        name: "Fork",
        description: null,
        htsCode: null,
        unitOfMeasure: "EA",
        sources: [
          { vendorName: "Vendor A", countryOfOrigin: null, unitCost: null },
        ],
      },
    ]);
    expect(issues.map((i) => i.row)).toEqual([2, 2, 2, 3]);
    expect(issues[0].message).toContain("chapter 98/99");
    expect(issues[3].message).toContain("no SKU");
  });

  it("drops per-vendor facts when no vendor is named", () => {
    const { items, issues } = extractCatalogItems(
      parseCsv(`SKU,Origin,Cost\nEB-1,CN,10`),
    );
    expect(items[0].sources).toEqual([]);
    expect(issues).toEqual([
      { row: 2, message: expect.stringContaining("no vendor named") },
    ]);
  });

  it("skips blank rows without issues and keeps row numbers aligned", () => {
    const { items, issues, rowCount } = extractCatalogItems(
      parseCsv(`SKU,Name\nEB-1,Fork\n,,\n,Nameless`),
    );
    expect(items).toHaveLength(1);
    expect(rowCount).toBe(2);
    expect(issues).toEqual([
      { row: 4, message: expect.stringContaining("no SKU") },
    ]);
  });

  it("fails cleanly when no SKU column exists, echoing the headers seen", () => {
    const result = extractCatalogItems(parseCsv("Foo,Bar\n1,2"));
    expect(result.items).toEqual([]);
    expect(result.headerRow).toBeNull();
    expect(result.issues[0].message).toContain("No SKU column");
    expect(result.issues[0].message).toContain("headers seen: Foo, Bar");
  });

  it("matches SKU-bearing headers by substring when exact synonyms miss", () => {
    const { items, headerRow } = extractCatalogItems(
      parseCsv("Customer SKU,Name\nEB-1,Fork"),
    );
    expect(headerRow).toBe(1);
    expect(items).toEqual([expect.objectContaining({ sku: "EB-1" })]);
  });
});

describe("extractFromSheets", () => {
  it("skips a cover tab and imports from the sheet that maps", () => {
    const result = extractFromSheets([
      { name: "Read Me", table: [["Instructions"], ["Fill in the tabs"]] },
      { name: "SKUs", table: parseCsv("SKU,Name\nEB-1,Fork") },
    ]);
    expect(result.sheet).toBe("SKUs");
    expect(result.items).toHaveLength(1);
  });

  it("lists scanned sheets when no tab has a SKU column", () => {
    const result = extractFromSheets([
      { name: "One", table: [["Foo"], ["1"]] },
      { name: "Two", table: [["Bar"], ["2"]] },
    ]);
    expect(result.items).toEqual([]);
    expect(result.issues.at(-1)?.message).toContain("Sheets scanned: One, Two");
  });
});
