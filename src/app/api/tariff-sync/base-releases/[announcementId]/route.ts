import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getSuperAdminActorName, requireSuperAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db";
import { ApplyValidationError } from "@/lib/tariff-sync/apply";
import { applyBaseRelease } from "@/lib/tariff-sync/base-apply";

// Approval re-reads the archived base payload, runs the full ETL, and
// re-audits touched entries across every org in one transaction — the
// heaviest request in the app.
export const maxDuration = 800;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    /** Overrides the staged effective date for the release's windows. */
    effectiveDate: isoDate.nullish(),
    /** Reviewer's explicit override of a tripped sanity guard. */
    force: z.boolean().optional(),
    notes: z.string().nullish(),
  }),
  z.object({
    action: z.literal("reject"),
    notes: z.string().nullish(),
  }),
]);

// Decide a staged base-schedule release. Approve = mark the queue item,
// re-derive the diff from the archived payload, re-run the sanity guard,
// write the windows, and re-audit — all in ONE transaction, so a failed
// apply (including a tripped guard without force) rolls the approval back.
// Reject dismisses the announcement.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ announcementId: string }> },
) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;
  const { announcementId } = await params;

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
  const body = parsed.data;

  try {
    const actor = await getSuperAdminActorName();
    const result = await db.transaction(async (tx) => {
      const item = await tx.query.reviewItems.findFirst({
        where: and(
          eq(schema.reviewItems.itemType, "tariff_base_release"),
          eq(schema.reviewItems.subjectId, announcementId),
          eq(schema.reviewItems.status, "pending"),
        ),
      });
      if (!item) {
        return {
          status: 404 as const,
          error:
            "No pending review item for this base release — it may have been decided or superseded. Refresh and retry.",
        };
      }

      if (body.action === "reject") {
        await tx
          .update(schema.reviewItems)
          .set({
            status: "rejected",
            resolutionAction: "reject",
            decidedBy: actor,
            decidedAt: new Date(),
            notes: body.notes ?? item.notes,
            updatedAt: new Date(),
          })
          .where(eq(schema.reviewItems.id, item.id));
        await tx
          .update(schema.tariffAnnouncements)
          .set({ status: "dismissed", updatedAt: new Date() })
          .where(eq(schema.tariffAnnouncements.id, announcementId));
        return { status: 200 as const, action: "rejected" as const };
      }

      await tx
        .update(schema.reviewItems)
        .set({
          status: "approved",
          resolutionAction: "accept",
          decidedBy: actor,
          decidedAt: new Date(),
          notes: body.notes ?? item.notes,
          updatedAt: new Date(),
        })
        .where(eq(schema.reviewItems.id, item.id));

      const applied = await applyBaseRelease(tx, announcementId, {
        effectiveDate: body.effectiveDate ?? undefined,
        force: body.force,
      });

      return { status: 200 as const, action: "applied" as const, ...applied };
    });

    if (result.status !== 200) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ApplyValidationError) {
      // Thrown inside the transaction, so the approval rolled back too.
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
