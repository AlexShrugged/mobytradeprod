// Pure helpers for the Parts page catalog import/export: RFC 4180 CSV
// parsing/writing, spreadsheet header mapping, and row normalization. No IO
// and no schema imports — XLSX decoding (exceljs) lives in import-xlsx.ts,
// database writes in import-service.ts. Tests colocated.

import { normalizeSku } from "./sku";

// ------------------------------------------------------------------- CSV

/** RFC 4180 parse: quoted fields, escaped quotes, embedded commas/newlines,
 *  CRLF/CR/LF row breaks. A UTF-8 BOM on the first cell is stripped. Blank
 *  rows are kept so issue row numbers match what the spreadsheet shows;
 *  extractCatalogItems skips them silently. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export const isBlankRow = (row: string[]): boolean =>
  row.every((c) => c.trim() === "");

/** One CSV cell, quoted when needed. Cells that would execute as formulas
 *  when the file opens in Excel (=, +, -, @ leads) get a leading apostrophe
 *  — vendor names arrive from third-party documents, so exported cells are
 *  not trusted. cleanCell() strips the apostrophe back off on import. */
export function toCsvCell(value: string | null): string {
  if (value === null || value === "") return "";
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

export function toCsv(rows: (string | null)[][]): string {
  return rows.map((r) => r.map(toCsvCell).join(",")).join("\r\n") + "\r\n";
}

// ------------------------------------------------------- header mapping

export type CatalogField =
  | "sku"
  | "name"
  | "description"
  | "htsCode"
  | "vendorName"
  | "countryOfOrigin"
  | "unitCost"
  | "unitOfMeasure";

// Matched against headers normalized to lowercase alphanumerics, so
// "HTS Code", "hts_code", and "HTS-Code" all land on htsCode. First match
// wins per field AND per column — a second "cost" column stays unmapped.
const HEADER_SYNONYMS: Record<CatalogField, string[]> = {
  sku: [
    "sku",
    "skunumber",
    "skuno",
    "skucode",
    "partnumber",
    "partno",
    "part",
    "itemnumber",
    "itemno",
    "item",
    "itemcode",
    "productcode",
    "productnumber",
    "productid",
  ],
  name: ["name", "partname", "productname", "itemname", "product", "title"],
  description: [
    "description",
    "desc",
    "productdescription",
    "itemdescription",
    "partdescription",
    "details",
  ],
  htsCode: [
    "htscode",
    "hts",
    "htsno",
    "htsnumber",
    "htsus",
    "tariffcode",
    "tariff",
    "tariffnumber",
    "harmonizedcode",
    "harmonizedtariffcode",
    "hscode",
    "hs",
  ],
  vendorName: [
    "vendor",
    "vendorname",
    "supplier",
    "suppliername",
    "manufacturer",
    "mfr",
    "mfg",
  ],
  countryOfOrigin: [
    "countryoforigin",
    "coo",
    "origin",
    "origincountry",
    "countryorigin",
    "country",
    "ctr",
    "ctry",
    "madein",
  ],
  unitCost: [
    "unitcost",
    "cost",
    "unitprice",
    "price",
    "costperunit",
    "priceperunit",
    "unitcostusd",
    "costusd",
    "fobprice",
    "fobcost",
  ],
  unitOfMeasure: ["unitofmeasure", "uom", "unit"],
};

// Synonyms too generic to trust as PREFIXES — "Part Notes", "Item Weight",
// "Unit Weight", "Country of Export", "Coordinator", "Mfg Date", "Tariff
// Rate" must not claim fields. They still match on exact equality above.
const PREFIX_DENY = new Set([
  "part",
  "partno", // "Part Notes"
  "item",
  "itemno",
  "skuno",
  "product",
  "name",
  "title",
  "details",
  "desc",
  "unit",
  "cost",
  "price",
  "country",
  "origin",
  "coo",
  "madein",
  "hs",
  "tariff",
  "mfr",
  "mfg",
]);

// Substring fallback, the last resort: real headers say "US HTS
// Classification", "Customer SKU", "HTS No. (10-digit)" — any header
// containing the fragment maps, as long as no earlier pass claimed the
// column. Longest fragments first, so the most specific column wins.
const HEADER_CONTAINS: Partial<Record<CatalogField, string[]>> = {
  sku: ["itemnumber", "partnumber", "sku"],
  htsCode: ["hts"],
};

const normalizeHeader = (h: string): string =>
  h.toLowerCase().replace(/[^a-z0-9]/g, "");

export type HeaderMap = Partial<Record<CatalogField, number>>;

const FIELDS = Object.keys(HEADER_SYNONYMS) as CatalogField[];

export function mapHeaders(headers: string[]): HeaderMap {
  const normalized = headers.map(normalizeHeader);
  const map: HeaderMap = {};
  const taken = new Set<number>();

  // Pass 1: exact equality (synonym list order = priority).
  for (const field of FIELDS) {
    for (const synonym of HEADER_SYNONYMS[field]) {
      const i = normalized.findIndex((h, idx) => h === synonym && !taken.has(idx));
      if (i >= 0) {
        map[field] = i;
        taken.add(i);
        break;
      }
    }
  }

  // Pass 2: synonym-as-prefix, longest synonym first ACROSS fields. ERP
  // exports suffix every header with table codes ("Item number MITBAL
  // MMS002", "CTR COUNTRY OF ORIGIN APGRL"), so equality never fires.
  // Global longest-first keeps "Supplier name …" (the vendor) ahead of
  // "Supplier …" (an id column) and "Part description" out of the SKU slot.
  const prefixCandidates = FIELDS.filter((f) => map[f] === undefined)
    .flatMap((field) =>
      HEADER_SYNONYMS[field]
        .filter((synonym) => !PREFIX_DENY.has(synonym))
        .map((synonym) => ({ field, synonym })),
    )
    .sort((a, b) => b.synonym.length - a.synonym.length);
  for (const { field, synonym } of prefixCandidates) {
    if (map[field] !== undefined) continue;
    const i = normalized.findIndex(
      (h, idx) => h.startsWith(synonym) && !taken.has(idx),
    );
    if (i >= 0) {
      map[field] = i;
      taken.add(i);
    }
  }

  // Pass 3: substring fallback.
  for (const field of Object.keys(HEADER_CONTAINS) as CatalogField[]) {
    if (map[field] !== undefined) continue;
    for (const fragment of HEADER_CONTAINS[field] ?? []) {
      const i = normalized.findIndex(
        (h, idx) => h.includes(fragment) && !taken.has(idx),
      );
      if (i >= 0) {
        map[field] = i;
        taken.add(i);
        break;
      }
    }
  }
  return map;
}

// ----------------------------------------------------------- row parsing

export type ImportIssue = {
  /** 1-based spreadsheet row, null for file-level issues. */
  row: number | null;
  message: string;
};

/** One vendor's sourcing facts for a SKU, as claimed by the file. */
export type CatalogImportSource = {
  vendorName: string;
  countryOfOrigin: string | null;
  /** Decimal string ready for the numeric column (4 dp). */
  unitCost: string | null;
};

/** One SKU's worth of file rows, merged. Null fields were not provided —
 *  the importer leaves the existing value alone rather than clearing it. */
export type CatalogImportItem = {
  sku: string;
  name: string | null;
  description: string | null;
  htsCode: string | null;
  unitOfMeasure: string | null;
  sources: CatalogImportSource[];
};

const cleanCell = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  // Strip the formula-escape apostrophe our own export writes (round-trip).
  const value = raw.trim().replace(/^'(?=[=+\-@])/, "");
  return value === "" ? null : value;
};

const normalizeHtsDigits = (code: string): string => code.replace(/\D/g, "");

/** Same commit rule the classification service enforces
 *  (assertValidCommitCode): 8 or 10 digits, not a Ch 98/99 overlay. Checked
 *  here so a bad code becomes a row issue instead of failing the import. */
const htsProblem = (code: string): string | null => {
  const digits = normalizeHtsDigits(code);
  if (digits.length !== 8 && digits.length !== 10) {
    return `invalid HTS code "${code}" (expected 8 or 10 digits)`;
  }
  if (digits.startsWith("98") || digits.startsWith("99")) {
    return `HTS code "${code}" is a chapter 98/99 program overlay, not a product classification`;
  }
  return null;
};

export type ExtractResult = {
  items: CatalogImportItem[];
  issues: ImportIssue[];
  /** Which spreadsheet header fed each field — provenance for the summary. */
  columns: Partial<Record<CatalogField, string>>;
  /** Data rows seen (header and blank rows excluded). */
  rowCount: number;
  /** 1-based row the header was found on; null = no SKU column found. */
  headerRow: number | null;
};

// How deep to look for the header row — exported spreadsheets stack title
// blocks, logos, and filter rows above the real table.
const HEADER_SCAN_ROWS = 25;

/** Full table → merged catalog items. The header row is the first row (of
 *  the first HEADER_SCAN_ROWS) that yields a SKU column; rows above it are
 *  title/preamble junk common in exported spreadsheets. */
export function extractCatalogItems(table: string[][]): ExtractResult {
  const issues: ImportIssue[] = [];

  let headerIndex = -1;
  let map: HeaderMap = {};
  for (let i = 0; i < Math.min(table.length, HEADER_SCAN_ROWS); i++) {
    if (isBlankRow(table[i])) continue;
    const candidate = mapHeaders(table[i]);
    if (candidate.sku !== undefined) {
      headerIndex = i;
      map = candidate;
      break;
    }
  }
  if (headerIndex < 0) {
    // Echo what the file actually says so a miss is diagnosable from the
    // dialog instead of a guessing game.
    const seen = (table.find((r) => !isBlankRow(r)) ?? [])
      .map((h) => h.trim())
      .filter(Boolean)
      .slice(0, 12);
    return {
      items: [],
      issues: [
        {
          row: null,
          message: `No SKU column found${
            seen.length > 0 ? ` (headers seen: ${seen.join(", ")})` : ""
          }. Include a header row with a column named SKU, Part Number, or Item Number.`,
        },
      ],
      columns: {},
      rowCount: 0,
      headerRow: null,
    };
  }

  const columns: Partial<Record<CatalogField, string>> = {};
  for (const [field, index] of Object.entries(map) as [CatalogField, number][]) {
    columns[field] = table[headerIndex][index].trim();
  }

  const cellAt = (row: string[], field: CatalogField): string | null =>
    map[field] === undefined ? null : cleanCell(row[map[field]]);

  const bySku = new Map<string, CatalogImportItem>();
  let rowCount = 0;
  for (let i = headerIndex + 1; i < table.length; i++) {
    const row = table[i];
    if (isBlankRow(row)) continue;
    const rowNumber = i + 1; // 1-based, as a spreadsheet shows it
    rowCount++;

    const sku = cellAt(row, "sku");
    if (sku === null) {
      issues.push({ row: rowNumber, message: "no SKU; row skipped" });
      continue;
    }
    if (sku.length > 64) {
      issues.push({
        row: rowNumber,
        message: `SKU "${sku.slice(0, 24)}…" is longer than 64 characters; row skipped`,
      });
      continue;
    }

    let htsCode = cellAt(row, "htsCode");
    if (htsCode !== null) {
      const problem = htsProblem(htsCode);
      if (problem !== null) {
        issues.push({ row: rowNumber, message: `${problem}; field skipped` });
        htsCode = null;
      }
    }

    let countryOfOrigin = cellAt(row, "countryOfOrigin")?.toUpperCase() ?? null;
    if (countryOfOrigin !== null && !/^[A-Z]{2}$/.test(countryOfOrigin)) {
      issues.push({
        row: rowNumber,
        message: `country of origin "${countryOfOrigin}" is not a 2-letter ISO code; field skipped`,
      });
      countryOfOrigin = null;
    }

    let unitCost: string | null = null;
    const rawCost = cellAt(row, "unitCost");
    if (rawCost !== null) {
      const parsed = Number(rawCost.replace(/[$,\s]/g, ""));
      if (Number.isFinite(parsed) && parsed >= 0) {
        unitCost = parsed.toFixed(4);
      } else {
        issues.push({
          row: rowNumber,
          message: `unit cost "${rawCost}" is not a non-negative number; field skipped`,
        });
      }
    }

    let unitOfMeasure = cellAt(row, "unitOfMeasure");
    if (unitOfMeasure !== null && unitOfMeasure.length > 16) {
      issues.push({
        row: rowNumber,
        message: `unit of measure "${unitOfMeasure}" is longer than 16 characters; field skipped`,
      });
      unitOfMeasure = null;
    }

    const vendorName = cellAt(row, "vendorName");
    if (vendorName === null && (countryOfOrigin !== null || unitCost !== null)) {
      // Cost and origin are (part, vendor) facts — same rule the manual New
      // SKU form enforces. Without a vendor there is no row to hang them on.
      issues.push({
        row: rowNumber,
        message:
          "no vendor named; origin and cost were not stored (they are per-vendor facts)",
      });
      countryOfOrigin = null;
      unitCost = null;
    }

    // Later rows for the same SKU override earlier ones field-by-field —
    // last write wins, matching the import's overwrite semantics. Keyed on
    // the normalized SKU (./sku): case-variant spellings are one SKU, and
    // the first spelling seen is the one stored.
    const skuKey = normalizeSku(sku);
    const item = bySku.get(skuKey) ?? {
      sku,
      name: null,
      description: null,
      htsCode: null,
      unitOfMeasure: null,
      sources: [],
    };
    item.name = cellAt(row, "name") ?? item.name;
    item.description = cellAt(row, "description") ?? item.description;
    item.htsCode = htsCode ?? item.htsCode;
    item.unitOfMeasure = unitOfMeasure ?? item.unitOfMeasure;
    if (vendorName !== null) {
      const key = vendorName.toLowerCase();
      const existing = item.sources.find(
        (s) => s.vendorName.toLowerCase() === key,
      );
      if (existing) {
        existing.countryOfOrigin = countryOfOrigin ?? existing.countryOfOrigin;
        existing.unitCost = unitCost ?? existing.unitCost;
      } else {
        item.sources.push({ vendorName, countryOfOrigin, unitCost });
      }
    }
    bySku.set(skuKey, item);
  }

  return {
    items: [...bySku.values()],
    issues,
    columns,
    rowCount,
    headerRow: headerIndex + 1,
  };
}

/** Multi-sheet workbooks: prefer the first sheet with importable items,
 *  then the first that at least had a SKU column (its row issues explain
 *  why nothing imported), then the first sheet's no-header diagnosis. */
export function extractFromSheets(
  sheets: { name: string; table: string[][] }[],
): ExtractResult & { sheet: string | null } {
  let headerOnly: (ExtractResult & { sheet: string | null }) | null = null;
  let first: (ExtractResult & { sheet: string | null }) | null = null;
  for (const { name, table } of sheets) {
    const result = { ...extractCatalogItems(table), sheet: name };
    first ??= result;
    if (result.items.length > 0) return result;
    if (result.headerRow !== null && headerOnly === null) headerOnly = result;
  }
  const chosen = headerOnly ?? first;
  if (chosen === null) {
    return {
      items: [],
      issues: [{ row: null, message: "The file has no readable rows." }],
      columns: {},
      rowCount: 0,
      headerRow: null,
      sheet: null,
    };
  }
  if (chosen.headerRow === null && sheets.length > 1) {
    chosen.issues.push({
      row: null,
      message: `Sheets scanned: ${sheets.map((s) => s.name).join(", ")}.`,
    });
  }
  return chosen;
}
