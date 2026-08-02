import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

const bodySchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1),
  description: z.string().nullish(),
  countryOfOrigin: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "Country of origin must be a 2-letter ISO code")
    .nullish(),
  manufacturer: z.string().nullish(),
  unitCost: z.number().nonnegative().finite().nullish(),
});

// The manual New SKU path: creates an ACTIVE part directly (a human typing
// the catalog entry IS the approval). The quote-entry path creates drafts
// via POST /api/quote-sheets instead. HTS is deliberately absent — codes
// arrive via classification or PATCH /api/parts/:partId.
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
  const input = parsed.data;

  const existing = await db.query.parts.findFirst({
    where: and(
      eq(schema.parts.orgId, orgId),
      eq(schema.parts.sku, input.sku),
    ),
  });
  if (existing) {
    return NextResponse.json(
      { error: `A part with SKU "${input.sku}" already exists.` },
      { status: 409 },
    );
  }

  const [part] = await db
    .insert(schema.parts)
    .values({
      orgId,
      sku: input.sku,
      name: input.name,
      description: input.description?.trim() || null,
      countryOfOrigin: input.countryOfOrigin?.trim().toUpperCase() || null,
      manufacturer: input.manufacturer?.trim() || null,
      unitCost: input.unitCost == null ? null : input.unitCost.toFixed(4),
      status: "active",
    })
    .returning();

  return NextResponse.json({ part }, { status: 201 });
}
