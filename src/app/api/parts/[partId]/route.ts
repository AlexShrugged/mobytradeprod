import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { updatePartHts } from "@/lib/classification/service";
import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

const bodySchema = z
  .object({
    htsCode: z.string().trim().min(1).optional(),
    note: z.string().optional(),
    // active↔archived only. Draft is NOT settable here: parts become draft
    // only through quote ingestion, and leave draft only through quote
    // approval (draft → active) or archiving.
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((b) => b.htsCode !== undefined || b.status !== undefined, {
    message: "Provide htsCode and/or status.",
  });

// Direct HTS edit on a catalog part — commits the code, supersedes any
// pending review item, records the change, and re-audits affected entries.
// Also accepts {status} for archive/unarchive.
export async function PATCH(
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
  const { htsCode, note, status } = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      let part: schema.Part | null = null;
      let reaudit = null;

      if (htsCode !== undefined) {
        const hts = await updatePartHts(tx, orgId, partId, htsCode, { note });
        if (!hts) return null;
        part = hts.part;
        reaudit = hts.reaudit;
      }

      if (status !== undefined) {
        const current =
          part ??
          (await tx.query.parts.findFirst({
            where: and(
              eq(schema.parts.id, partId),
              eq(schema.parts.orgId, orgId),
            ),
          })) ??
          null;
        if (!current) return null;
        // Unarchiving always lands on active; draft → active goes through
        // quote approval, never through this route.
        if (status === "active" && current.status === "draft") {
          throw new PartStateError(
            "Draft parts activate through quote approval, not a status edit.",
          );
        }
        if (current.status !== status) {
          const [updated] = await tx
            .update(schema.parts)
            .set({ status, updatedAt: new Date() })
            .where(eq(schema.parts.id, partId))
            .returning();
          part = updated;
        } else {
          part = current;
        }
      }

      return { part, reaudit };
    });

    if (!result) {
      return NextResponse.json({ error: "Part not found." }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PartStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof Error && err.message.startsWith("Invalid HTS code")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

class PartStateError extends Error {}
