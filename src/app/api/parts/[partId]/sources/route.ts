import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { reauditEntriesForPart } from "@/lib/audit/auditor";
import { db, schema } from "@/lib/db";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";
import { findOrCreateVendor } from "@/lib/vendors/service";

const bodySchema = z.object({
  vendorName: z.string().trim().min(1, "Vendor name is required"),
  countryOfOrigin: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "Country of origin must be a 2-letter ISO code")
    .nullish(),
  unitCost: z.number().nonnegative().finite().nullish(),
});

const todayIso = () => new Date().toISOString().slice(0, 10);

// Adds a vendor source to a part — the manual counterpart of a quote
// arriving from a new vendor. One row per (part, vendor); 409 when the pair
// already exists. A COO here changes what the auditor expects on entry
// lines, so the part's entries re-audit in the same request.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ partId: string }> },
) {
  const { partId } = await params;
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

  const actor = await getCurrentActorName();
  const outcome = await db.transaction(async (tx) => {
    const part = await tx.query.parts.findFirst({
      where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
    });
    if (!part) return { kind: "not_found" as const };

    const vendor = await findOrCreateVendor(tx, orgId, input.vendorName);
    if (!vendor) return { kind: "not_found" as const }; // unreachable: zod min(1)

    const existing = await tx.query.partSources.findFirst({
      where: and(
        eq(schema.partSources.partId, partId),
        eq(schema.partSources.vendorId, vendor.id),
        isNull(schema.partSources.validTo),
      ),
    });
    if (existing) {
      return { kind: "conflict" as const, vendorName: vendor.name };
    }

    // Closed windows mean this vendor sourced the part before and was
    // removed — the new window starts today rather than rewriting the gap.
    const priorWindow = await tx.query.partSources.findFirst({
      where: and(
        eq(schema.partSources.partId, partId),
        eq(schema.partSources.vendorId, vendor.id),
      ),
    });

    const countryOfOrigin = input.countryOfOrigin?.trim().toUpperCase() || null;
    const unitCost = input.unitCost == null ? null : input.unitCost.toFixed(4);
    const [source] = await tx
      .insert(schema.partSources)
      .values({
        orgId,
        partId,
        vendorId: vendor.id,
        countryOfOrigin,
        unitCost,
        validFrom: priorWindow ? todayIso() : null,
      })
      .returning();

    const seeded: [string, string | null][] = [
      ["country_of_origin", countryOfOrigin],
      ["unit_cost", unitCost],
    ];
    for (const [field, newValue] of seeded) {
      if (newValue === null) continue;
      await tx.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: partId,
        vendorId: vendor.id,
        field,
        oldValue: null,
        newValue,
        source: "manual_edit",
        actor,
      });
    }

    const reaudit = countryOfOrigin
      ? await reauditEntriesForPart(tx, orgId, partId)
      : null;
    return { kind: "created" as const, source, reaudit };
  });

  if (outcome.kind === "not_found") {
    return NextResponse.json({ error: "Part not found." }, { status: 404 });
  }
  if (outcome.kind === "conflict") {
    return NextResponse.json(
      {
        error: `${outcome.vendorName} is already a source for this part. Edit that row instead.`,
      },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { source: outcome.source, reaudit: outcome.reaudit },
    { status: 201 },
  );
}
