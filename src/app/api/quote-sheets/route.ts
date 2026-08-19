import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { adoptEntryLinesForParts } from "@/lib/processing/linker";
import { ingestQuoteSheet } from "@/lib/quotes/service";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

const lineSchema = z.object({
  lineNumber: z.number().int().positive(),
  sku: z.string().trim().min(1).max(64),
  description: z.string().nullish(),
  unitCost: z.number().nonnegative().finite(),
  currency: z.string().length(3).nullish(),
  countryOfOrigin: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "Country of origin must be a 2-letter ISO code")
    .nullish(),
  htsCode: z.string().max(12).nullish(),
  moq: z.number().nonnegative().nullish(),
  leadTimeDays: z.number().int().nonnegative().nullish(),
  unitOfMeasure: z.string().max(16).nullish(),
});

const bodySchema = z.object({
  supplierName: z.string().nullish(),
  quoteDate: isoDate.nullish(),
  currency: z.string().length(3).nullish(),
  validUntil: isoDate.nullish(),
  notes: z.string().nullish(),
  lines: z
    .array(lineSchema)
    .min(1)
    .refine(
      (lines) => new Set(lines.map((l) => l.lineNumber)).size === lines.length,
      "Line numbers must be unique within a sheet",
    ),
});

// Manual quote entry (New SKU dialog / add-quote form) — the same ingestion
// path uploaded quote sheets take, minus the document: documentId stays
// null, so provenance is the actor on the derived quote_received event.
export async function POST(request: Request) {
  const orgId = await getCurrentOrgId();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: z.prettifyError(parsed.error) },
      { status: 400 },
    );
  }

  const result = await db.transaction(async (tx) => {
    const ingested = await ingestQuoteSheet(tx, orgId, {
      ...parsed.data,
      documentId: null,
    });
    // Draft parts this sheet created adopt any entry lines that predate
    // them — same as the uploaded-sheet path in processing/linker.
    await adoptEntryLinesForParts(tx, orgId, ingested.createdPartIds);
    return ingested;
  });
  return NextResponse.json(result, { status: 201 });
}
