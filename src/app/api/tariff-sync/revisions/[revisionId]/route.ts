import { NextResponse } from "next/server";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getSuperAdminActorName, requireSuperAdmin } from "@/lib/admin";
import {
  processPendingAnalyses,
  queueReanalysesAllOrgs,
  queueReanalysesForEntries,
} from "@/lib/analysis/service";
import {
  findEntriesForMeasures,
  sweepAuditsAllOrgs,
  sweepAuditsForEntries,
  type ReauditSummary,
} from "@/lib/audit/auditor";
import { db, schema } from "@/lib/db";
import {
  applyRevision,
  ApplyValidationError,
  resolveAnnouncementIfTerminal,
} from "@/lib/tariff-sync/apply";
import type { ProposedMeasureChange } from "@/lib/tariff-sync/types";

// Approval applies the revision and queues re-analyses in one transaction;
// the scoped re-audit (entries whose lines the measure's prefixes touch)
// runs right after commit — well past the platform's default duration.
export const maxDuration = 800;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

// On approve, the reviewer's CONFIRMED values — exactly the fields the
// structured feed never carries reliably: the date windows and the
// country scope. The evidence highlights and extraction chips are
// suggestions for choosing these values, never auto-applied.
const isoCountry = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "Expected a 2-letter ISO country code")
  .transform((c) => c.toUpperCase());

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    effectiveDate: isoDate.nullish(),
    endDate: isoDate.nullish(),
    sailedOnOrAfter: isoDate.nullish(),
    sailedOnOrBefore: isoDate.nullish(),
    /** Null = the measure applies to every country of origin. */
    countries: z.array(isoCountry).nullish(),
    countriesExcluded: z.array(isoCountry).nullish(),
    /** Legal-program identity (exclusivity + conflict key); null clears the
     *  differ's inference. */
    program: z.string().trim().min(1).max(80).nullish(),
    /** Explicit confirmation that null countries means every country —
     *  create_measure applies refuse worldwide scope without it. */
    worldwide: z.boolean().optional(),
    /** Resolution when this measure overlaps live same-program measures:
     *  supersede (close their windows, link lineage) or stack. */
    onConflict: z.enum(["supersede", "stack"]).nullish(),
    notes: z.string().nullish(),
  }),
  z.object({
    action: z.literal("reject"),
    notes: z.string().nullish(),
  }),
]);

const DATE_FIELDS = [
  "effectiveDate",
  "endDate",
  "sailedOnOrAfter",
  "sailedOnOrBefore",
] as const;

const COUNTRY_FIELDS = ["countries", "countriesExcluded"] as const;

// Decide a staged Chapter 99 revision. Approve = merge the confirmed dates
// into the proposal, mark the queue item, run the apply planner (window
// tiling), and re-audit — all in ONE transaction, so a failed apply rolls
// the approval back instead of parking an approved-but-unapplied revision.
// Reject just resolves the queue item.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ revisionId: string }> },
) {
  // Approving a revision mutates GLOBAL reference data — super admin only.
  const denied = await requireSuperAdmin();
  if (denied) return denied;
  const { revisionId } = await params;

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
      const revision = await tx.query.measureRevisions.findFirst({
        where: eq(schema.measureRevisions.id, revisionId),
      });
      if (!revision) {
        return { status: 404 as const, error: "Revision not found." };
      }
      if (revision.appliedAt) {
        return {
          status: 409 as const,
          error: "This revision was already applied and can no longer change.",
        };
      }

      // Global queue: tariff items carry no org.
      const item = await tx.query.reviewItems.findFirst({
        where: and(
          eq(schema.reviewItems.itemType, "tariff_measure_revision"),
          eq(schema.reviewItems.subjectId, revisionId),
        ),
      });
      if (!item) {
        return { status: 404 as const, error: "Review item not found." };
      }
      if (item.status === "superseded") {
        return {
          status: 409 as const,
          error: "A newer sync superseded this revision. Review the latest one.",
        };
      }
      if (item.status !== "pending") {
        return {
          status: 409 as const,
          error: `This revision is already ${item.status}. Refresh and retry.`,
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
        await resolveAnnouncementIfTerminal(tx, revision.announcementId);
        return { status: 200 as const, action: "rejected" as const };
      }

      // Approve: fold the confirmed dates into the proposal first — apply
      // writes exactly what the reviewer confirmed.
      const proposed = {
        ...(revision.proposed as ProposedMeasureChange),
      };
      for (const field of DATE_FIELDS) {
        if (body[field] !== undefined) proposed[field] = body[field];
      }
      for (const field of COUNTRY_FIELDS) {
        if (body[field] !== undefined) {
          proposed[field] =
            body[field] === null || body[field].length === 0
              ? null
              : body[field];
        }
      }
      if (body.program !== undefined) proposed.program = body.program;
      if (body.worldwide !== undefined) proposed.worldwide = body.worldwide;
      if (body.onConflict !== undefined) proposed.onConflict = body.onConflict;
      await tx
        .update(schema.measureRevisions)
        .set({ proposed, updatedAt: new Date() })
        .where(eq(schema.measureRevisions.id, revisionId));

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

      const applied = await applyRevision(tx, revisionId);
      if (!applied) {
        return { status: 404 as const, error: "Revision not found." };
      }

      // The blast radius: entries whose declared digits fall under the
      // measure's prefixes (applied + target measure covers tiles and
      // narrowed scopes; the proposal's own prefixes are a safety superset).
      // null = an all_products measure — only then sweep everything.
      const targets =
        applied.measureId === null
          ? null
          : await findEntriesForMeasures(
              tx,
              [applied.measureId, revision.targetMeasureId].filter(
                (id): id is string => id !== null,
              ),
              proposed.prefixes ?? [],
            );

      // AI findings persist too, but re-deriving them costs real model runs
      // — queue them here (transactional) and process after the response.
      const analysesQueued =
        targets === null
          ? await queueReanalysesAllOrgs(tx)
          : await queueReanalysesForEntries(
              tx,
              targets.map((t) => t.entryId),
            );

      return {
        status: 200 as const,
        action: "applied" as const,
        measureId: applied.measureId,
        targets,
        analysesQueued,
      };
    });

    if (result.status !== 200) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    if (result.action !== "applied") {
      return NextResponse.json(result);
    }

    // Measure windows changed — re-derive persisted audit findings for the
    // touched entries (expected charges self-heal on read; alerts do not).
    // AFTER commit: the auditor reconciles idempotently, so a failed sweep
    // leaves the applied reference intact and heals on the next sweep,
    // instead of rolling an approved apply back.
    let audit: ReauditSummary | null = null;
    let auditError: string | null = null;
    try {
      audit =
        result.targets === null
          ? await sweepAuditsAllOrgs(db)
          : await sweepAuditsForEntries(db, result.targets);
    } catch (err) {
      auditError = err instanceof Error ? err.message : String(err);
      console.error("re-audit after tariff apply failed:", err);
    }

    if (result.analysesQueued > 0) {
      after(async () => {
        await processPendingAnalyses(db).catch((err) => {
          console.error("re-analysis after tariff apply failed:", err);
        });
      });
    }
    // targets: undefined drops the (possibly huge) id list from the JSON.
    return NextResponse.json({ ...result, targets: undefined, audit, auditError });
  } catch (err) {
    if (err instanceof ApplyValidationError) {
      // Thrown inside the transaction, so the approval rolled back too.
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
