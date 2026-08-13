import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";
import { findOrCreateVendor } from "@/lib/vendors/service";

const bodySchema = z
  .object({
    sku: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1),
    description: z.string().nullish(),
    vendorName: z.string().nullish(),
    countryOfOrigin: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "Country of origin must be a 2-letter ISO code")
      .nullish(),
    unitCost: z.number().nonnegative().finite().nullish(),
  })
  .refine(
    (b) =>
      b.vendorName?.trim() || (b.countryOfOrigin == null && b.unitCost == null),
    {
      message:
        "Name the vendor to set origin and cost.",
    },
  );

// The manual New SKU path: creates an ACTIVE part directly (a human typing
// the catalog entry IS the approval), plus its first (part, vendor) source
// row when a vendor is named. The quote-entry path creates drafts via
// POST /api/quote-sheets instead. HTS is deliberately absent — codes arrive
// via classification or PATCH /api/parts/:partId.
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

  const actor = await getCurrentActorName();
  const part = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.parts)
      .values({
        orgId,
        sku: input.sku,
        name: input.name,
        description: input.description?.trim() || null,
        status: "active",
      })
      .returning();

    const vendor = await findOrCreateVendor(tx, orgId, input.vendorName);
    if (vendor) {
      const countryOfOrigin = input.countryOfOrigin?.trim().toUpperCase() || null;
      const unitCost =
        input.unitCost == null ? null : input.unitCost.toFixed(4);
      await tx.insert(schema.partSources).values({
        orgId,
        partId: created.id,
        vendorId: vendor.id,
        countryOfOrigin,
        unitCost,
      });
      // Creation provenance for the source facts — the same rows an edit
      // would write, so history starts at birth instead of the first edit.
      const seeded: [string, string | null][] = [
        ["country_of_origin", countryOfOrigin],
        ["unit_cost", unitCost],
      ];
      for (const [field, newValue] of seeded) {
        if (newValue === null) continue;
        await tx.insert(schema.fieldChanges).values({
          orgId,
          entityType: "part",
          entityId: created.id,
          vendorId: vendor.id,
          field,
          oldValue: null,
          newValue,
          source: "manual_edit",
          actor,
        });
      }
    }

    return created;
  });

  return NextResponse.json({ part }, { status: 201 });
}
