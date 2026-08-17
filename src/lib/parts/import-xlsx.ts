import ExcelJS from "exceljs";

// XLSX → the same string[][] shape parseCsv produces, so extractCatalogItems
// stays format-blind. Every worksheet is returned — real files hide the SKU
// table behind a cover/instructions tab, and extractFromSheets picks the
// sheet that actually maps.

type CellValue = ExcelJS.CellValue;

function cellToString(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value) {
      return value.richText.map((r) => r.text).join("");
    }
    if ("text" in value) return String(value.text); // hyperlink cells
    if ("result" in value) {
      // Formula cell — use the cached result, never the formula text.
      return value.result === undefined || value.result instanceof Object
        ? ""
        : String(value.result);
    }
    if ("error" in value) return "";
  }
  return String(value);
}

function sheetToTable(sheet: ExcelJS.Worksheet): string[][] {
  // Indexed by sheet row so blank rows keep their place — issue row numbers
  // must match what the spreadsheet shows (same contract as parseCsv).
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    // row.values is 1-indexed (index 0 is unused); missing cells are holes.
    const values = row.values as CellValue[];
    for (let i = 1; i < values.length; i++) {
      cells.push(cellToString(values[i]));
    }
    rows[rowNumber - 1] = cells;
  });
  return Array.from(rows, (r) => r ?? []);
}

export async function readXlsxTables(
  buffer: Buffer,
): Promise<{ name: string; table: string[][] }[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    table: sheetToTable(sheet),
  }));
}
