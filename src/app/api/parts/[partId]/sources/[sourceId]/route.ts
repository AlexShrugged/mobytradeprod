import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";

import { reauditEntriesForPart } from "@/lib/audit/auditor";
import { db, schema } from "@/lib/db";
import { planCloseDate, planCommitWindow } from "@/lib/effective-dating";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";

// Inline edits for one (part, vendor) source row — the EditableCell
// endpoint (one field per PATCH, like the part fields route). COO edits
// change what the auditor expects on this part's entry lines, so those
// re-audit in the same transaction. Only the CURRENT window is editable;
// an edit without an effectiveDate corrects it in place ("was always so"),
// an edit WITH one tiles a new window from that day.
const EDITABLE_FIELDS = new Set(["countryOfOrigin", "unitCost"]);

const todayIso = () => new Date().toISOString().slice(0, 10);

const FIELD_CHANGE_NAMES: Record<string, string> = {
  countryOfOrigin: "country_of_origin",
  unitCost: "unit_cost",
};

// Takes the caller's handle: a global-db query inside db.transaction
// deadlocks on PGlite (single session — the tx holds its lock).
async function loadSource(
  tx: Pick<typeof db, "query">,
  partId: string,
  sourceId: string,
  orgId: string,
) {
  return tx.query.partSources.findFirst({
    where: and(
      eq(schema.partSources.id, sourceId),
      eq(schema.partSources.partId, partId),
      eq(schema.partSources.orgId, orgId),
      // Closed windows are audit history — only the current row is editable.
      isNull(schema.partSources.validTo),
    ),
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ partId: string; sourceId: string }> },
) {
  const { partId, sourceId } = await params;
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

  // Optional: date the change instead of correcting the current window.
  let effectiveDate: string | null = null;
  if (body.effectiveDate != null && body.effectiveDate !== "") {
    if (
      typeof body.effectiveDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveDate)
    ) {
      return NextResponse.json(
        { error: "effectiveDate must be a YYYY-MM-DD date." },
        { status: 400 },
      );
    }
    effectiveDate = body.effectiveDate;
  }

  const patch: Partial<typeof schema.partSources.$inferInsert> = {};
  for (const [key, raw] of entries) {
    const value = raw === null ? null : String(raw).trim();
    switch (key) {
      case "countryOfOrigin": {
        if (value === null || value === "") {
          patch.countryOfOrigin = null;
          break;
        }
        const coo = value.toUpperCase();
        if (!/^[A-Z]{2}$/.test(coo)) {
          return NextResponse.json(
            { error: "Country of origin must be a 2-letter ISO code." },
            { status: 400 },
          );
        }
        patch.countryOfOrigin = coo;
        break;
      }
      case "unitCost": {
        if (value === null || value === "") {
          patch.unitCost = null;
          break;
        }
        const cost = Number(value);
        if (!Number.isFinite(cost) || cost < 0) {
          return NextResponse.json(
            { error: "Unit cost must be a non-negative number." },
            { status: 400 },
          );
        }
        patch.unitCost = cost.toFixed(4);
        break;
      }
    }
  }

  const actor = await getCurrentActorName();
  const result = await db.transaction(async (tx) => {
    const source = await loadSource(tx, partId, sourceId, orgId);
    if (!source) return null;

    const plan = planCommitWindow(
      { validFrom: source.validFrom },
      effectiveDate,
    );
    let updated: schema.PartSource;
    let tiled = false;
    if (plan.action === "tile") {
      tiled = true;
      await tx
        .update(schema.partSources)
        .set({ validTo: plan.closePredecessorAt, updatedAt: new Date() })
        .where(eq(schema.partSources.id, sourceId));
      [updated] = await tx
        .insert(schema.partSources)
        .values({
          orgId,
          partId,
          vendorId: source.vendorId,
          countryOfOrigin: source.countryOfOrigin,
          unitCost: source.unitCost,
          ...patch,
          validFrom: effectiveDate,
          validTo: null,
        })
        .returning();
    } else {
      [updated] = await tx
        .update(schema.partSources)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.partSources.id, sourceId))
        .returning();
    }

    let cooChanged = false;
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      const oldValue = (source[key as keyof schema.PartSource] ?? null) as
        | string
        | null;
      const newValue = (patch[key] ?? null) as string | null;
      if (oldValue === newValue) continue;
      if (key === "countryOfOrigin") cooChanged = true;
      await tx.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: partId,
        vendorId: source.vendorId,
        field: FIELD_CHANGE_NAMES[key as string] ?? (key as string),
        oldValue,
        newValue,
        source: "manual_edit",
        actor,
      });
    }

    // A tiled window shifts as-of expectations even when only cost moved.
    const reaudit =
      cooChanged || tiled
        ? await reauditEntriesForPart(tx, orgId, partId)
        : null;
    return { source: updated, reaudit };
  });

  if (!result) {
    return NextResponse.json({ error: "Source not found." }, { status: 404 });
  }
  return NextResponse.json(result);
}

// Removing a source is a catalog statement ("we no longer buy this SKU from
// that vendor") — it CLOSES the current window rather than deleting the row,
// so historical entries inside the window keep auditing against it while
// entries after the close stop being constrained by it. Recorded as removal
// field_changes and re-audited, since the COO expectation set shrinks.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ partId: string; sourceId: string }> },
) {
  const { partId, sourceId } = await params;
  const orgId = await getCurrentOrgId();

  const actor = await getCurrentActorName();
  const result = await db.transaction(async (tx) => {
    const source = await loadSource(tx, partId, sourceId, orgId);
    if (!source) return null;

    await tx
      .update(schema.partSources)
      .set({
        validTo: planCloseDate(source.validFrom, todayIso()),
        updatedAt: new Date(),
      })
      .where(eq(schema.partSources.id, sourceId));

    const removed: [string, string | null][] = [
      ["country_of_origin", source.countryOfOrigin],
      ["unit_cost", source.unitCost],
    ];
    for (const [field, oldValue] of removed) {
      if (oldValue === null) continue;
      await tx.insert(schema.fieldChanges).values({
        orgId,
        entityType: "part",
        entityId: partId,
        vendorId: source.vendorId,
        field,
        oldValue,
        newValue: null,
        source: "manual_edit",
        actor,
        note: "Vendor source removed",
      });
    }

    const reaudit = source.countryOfOrigin
      ? await reauditEntriesForPart(tx, orgId, partId)
      : null;
    return { reaudit };
  });

  if (!result) {
    return NextResponse.json({ error: "Source not found." }, { status: 404 });
  }
  return NextResponse.json(result);
}
