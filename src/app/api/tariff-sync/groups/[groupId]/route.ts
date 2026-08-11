import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getSuperAdminActorName, requireSuperAdmin } from "@/lib/admin";
import { sweepAuditsAllOrgs } from "@/lib/audit/auditor";
import { db, schema } from "@/lib/db";
import {
  applyRevisionGroup,
  ApplyValidationError,
  resolveAnnouncementIfTerminal,
} from "@/lib/tariff-sync/apply";

// Approval applies the whole family group and re-audits every org in one
// transaction — well past the platform's default function duration.
export const maxDuration = 800;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    /** Folded into members whose proposed effective date is still null —
     *  the reviewer's confirmed fallback (create_measure requires one). */
    defaultEffectiveDate: isoDate.nullish(),
    /** Folded into members whose proposed end date is still null — for
     *  bulk-adopting already-terminated families. */
    defaultEndDate: isoDate.nullish(),
    /** Per-member reviewer-confirmed effective dates (revision id → date);
     *  members of one family legitimately carry different dates. */
    memberEffectiveDates: z.record(z.string(), isoDate).optional(),
    /** Unchecked members — rejected, finalized by this same approval. */
    skipRevisionIds: z.array(z.string()).optional(),
    notes: z.string().nullish(),
  }),
  z.object({
    action: z.literal("reject"),
    notes: z.string().nullish(),
  }),
]);

// Decide a wholesale-adoption group. Approve = mark the queue item, apply
// EVERY included member (all-or-nothing: one failing member rolls the whole
// approval back with the codes listed), and re-audit all orgs — one
// transaction. Reject resolves the item; members become terminal through
// the group gate.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const denied = await requireSuperAdmin();
  if (denied) return denied;
  const { groupId } = await params;

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
      const group = await tx.query.measureRevisionGroups.findFirst({
        where: eq(schema.measureRevisionGroups.id, groupId),
      });
      if (!group) {
        return { status: 404 as const, error: "Adoption group not found." };
      }

      const item = await tx.query.reviewItems.findFirst({
        where: and(
          eq(schema.reviewItems.itemType, "tariff_measure_group"),
          eq(schema.reviewItems.subjectId, groupId),
          eq(schema.reviewItems.status, "pending"),
        ),
      });
      if (!item) {
        return {
          status: 409 as const,
          error:
            "No pending review item for this group — it may have been decided or superseded. Refresh and retry.",
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
        await resolveAnnouncementIfTerminal(tx, group.announcementId);
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

      const applied = await applyRevisionGroup(tx, groupId, {
        defaultEffectiveDate: body.defaultEffectiveDate ?? undefined,
        defaultEndDate: body.defaultEndDate ?? undefined,
        memberEffectiveDates: body.memberEffectiveDates,
        skipRevisionIds: body.skipRevisionIds,
        decidedBy: actor,
      });
      if (!applied) {
        return { status: 404 as const, error: "Adoption group not found." };
      }

      // Measure windows changed globally — re-derive persisted audit
      // findings for every org.
      const audit = await sweepAuditsAllOrgs(tx);

      return {
        status: 200 as const,
        action: "applied" as const,
        applied: applied.applied,
        rejected: applied.rejected,
        audit,
      };
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
