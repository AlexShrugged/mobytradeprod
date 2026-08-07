import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";

// Inline edits for the part's OWN simple fields. Cost and country of origin
// live on the (part, vendor) source rows — those edit through
// /api/parts/:partId/sources/:sourceId. HTS changes are deliberately NOT
// accepted here either — they go through PATCH /api/parts/:partId, which
// routes them via the classification service (review-queue supersede +
// re-audit).
const EDITABLE_FIELDS = new Set(["name", "description"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ partId: string }> },
) {
  const { partId } = await params;
  const orgId = await getCurrentOrgId();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const entries = Object.entries(body).filter(([k]) => EDITABLE_FIELDS.has(k));
  if (entries.length === 0) {
    return NextResponse.json(
      { error: "No editable field in body." },
      { status: 400 },
    );
  }

  const patch: Partial<typeof schema.parts.$inferInsert> = {};
  for (const [key, raw] of entries) {
    const value = raw === null ? null : String(raw).trim();
    switch (key) {
      case "name":
        if (!value) {
          return NextResponse.json(
            { error: "Name cannot be empty." },
            { status: 400 },
          );
        }
        patch.name = value;
        break;
      case "description":
        patch.description = value || null;
        break;
    }
  }

  const actor = await getCurrentActorName();
  const result = await db.transaction(async (tx) => {
    const part = await tx.query.parts.findFirst({
      where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
    });
    if (!part) return null;

    const [updated] = await tx
      .update(schema.parts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.parts.id, partId))
      .returning();

    // One field_changes row per field that actually changed — the actor
    // record behind "changed by <user>" in the events feed.
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      const oldValue = (part[key as keyof schema.Part] ?? null) as string | null;
      const newValue = (patch[key] ?? null) as string | null;
      if (oldValue === newValue) continue;
      await tx.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: partId,
        field: key as string,
        oldValue,
        newValue,
        source: "manual_edit",
        actor,
      });
    }

    return updated;
  });

  if (!result) {
    return NextResponse.json({ error: "Part not found." }, { status: 404 });
  }
  return NextResponse.json({ part: result });
}
