import { NextResponse } from "next/server";

import { resolveSourceId } from "@/lib/documents/source";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";
import { extractFromSheets, parseCsv } from "@/lib/parts/import-file";
import { applyCatalogImport } from "@/lib/parts/import-service";
import { readXlsxTables } from "@/lib/parts/import-xlsx";
import { getFileStore } from "@/lib/storage";

// A whole-catalog import runs a couple hundred thousand statements (~100s
// on local PGlite for 26k SKUs); network round-trips to hosted Postgres
// stretch that further. Same ceiling as document processing.
export const maxDuration = 800;

// A whole-catalog CSV runs well under this; the guard is against mistaken
// uploads (a PDF scan, a photo), not real SKU lists.
const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Excel writes UTF-16 CSVs on some export paths — sniff the BOM instead of
// assuming UTF-8.
function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  }
  return buffer.toString("utf8"); // parseCsv strips a UTF-8 BOM itself
}

// The Parts page SKU-list import: parse CSV/XLSX, upsert the catalog, and
// file the upload as a processed part_catalog document (Data page row).
export async function POST(request: Request) {
  const orgId = await getCurrentOrgId();

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "File is larger than 20MB." },
      { status: 400 },
    );
  }

  const name = file.name.toLowerCase();
  const isCsv = name.endsWith(".csv") || name.endsWith(".txt");
  const isXlsx = name.endsWith(".xlsx");
  if (!isCsv && !isXlsx) {
    return NextResponse.json(
      {
        error: name.endsWith(".xls")
          ? "Legacy .xls is not supported. Save the sheet as .xlsx or .csv."
          : "Upload a .csv or .xlsx file.",
      },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let sheets: { name: string; table: string[][] }[];
  try {
    sheets = isCsv
      ? [{ name: file.name, table: parseCsv(decodeText(buffer)) }]
      : await readXlsxTables(buffer);
  } catch {
    return NextResponse.json(
      { error: "The file could not be read as a spreadsheet." },
      { status: 400 },
    );
  }

  const { items, issues, columns, rowCount } = extractFromSheets(sheets);
  if (items.length === 0) {
    return NextResponse.json(
      { error: "No importable SKU rows found.", issues },
      { status: 400 },
    );
  }

  const [actor, resolved] = await Promise.all([
    getCurrentActorName(),
    resolveSourceId(orgId, null), // the org's manual-upload intake channel
  ]);

  const store = getFileStore();
  const { storageKey } = await store.put(file.name, buffer);

  const summary = await applyCatalogImport({
    orgId,
    actor,
    items,
    issues,
    columns,
    rowCount,
    file: {
      fileName: file.name,
      fileSize: buffer.byteLength,
      mimeType:
        file.type ||
        (isCsv
          ? "text/csv"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      storageKey,
      sourceId: resolved.ok ? resolved.sourceId : null,
    },
  });

  return NextResponse.json({ summary }, { status: 200 });
}
