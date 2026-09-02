import { NextResponse, after } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  AFTER_RESPONSE_DRAIN,
  processPendingAnalyses,
  queueReanalysesForOrgRule,
} from "@/lib/analysis/service";
import { sweepAudits } from "@/lib/audit/auditor";
import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import {
  sameAnalystSemantics,
  sameSuppressionSemantics,
  suppressionSpecSchema,
  type SuppressionSpec,
} from "@/lib/org-rules";

// See org-rules/route.ts: the after() drain must outlive its investigations.
export const maxDuration = 800;

/** Queue re-analysis for the entries a rule change touches and drain after
 *  the response. `scopes` carries every rule state involved (before and/or
 *  after) — see queueReanalysesForOrgRule for the blast-radius rules. */
async function queueAndDrain(
  orgId: string,
  scopes: (SuppressionSpec | null)[],
): Promise<number> {
  const queued = await queueReanalysesForOrgRule(db, orgId, scopes);
  if (queued > 0) {
    after(async () => {
      await processPendingAnalyses(db, AFTER_RESPONSE_DRAIN).catch((err) => {
        console.error("re-analysis after org rule change failed:", err);
      });
    });
  }
  return queued;
}

const specOf = (rule: { suppression: unknown }): SuppressionSpec | null =>
  (rule.suppression as SuppressionSpec | null) ?? null;

const bodySchema = z
  .object({
    text: z.string().trim().min(1).max(300).optional(),
    /** null clears the spec — the rule becomes guidance-only. */
    suppression: suppressionSpecSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (b) => b.text !== undefined || b.suppression !== undefined || b.enabled !== undefined,
    { message: "Nothing to update." },
  );

// Edits and toggles re-sweep the org only when the rule's effect on the
// auditor changed (spec edits, spec add/remove, enable/disable flips on
// suppression rules) — text-only edits and guidance toggles skip it.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> },
) {
  const { ruleId } = await params;
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

  const existing = await db.query.orgRules.findFirst({
    where: and(
      eq(schema.orgRules.id, ruleId),
      eq(schema.orgRules.orgId, orgId),
    ),
  });
  if (!existing) {
    return NextResponse.json({ error: "Rule not found." }, { status: 404 });
  }

  const [rule] = await db
    .update(schema.orgRules)
    .set({
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.suppression !== undefined
        ? { suppression: input.suppression }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.orgRules.id, existing.id))
    .returning();

  const reaudit = sameSuppressionSemantics(existing, rule)
    ? null
    : await sweepAudits(db, orgId);

  // The analyst sees more than the auditor (text, guidance rules), so this
  // gate is wider than the sweep's. Scope by whichever rule states were
  // live: the before spec covers entries the rule stops applying to, the
  // after spec covers ones it starts applying to.
  let analysesQueued = 0;
  if (!sameAnalystSemantics(existing, rule)) {
    const scopes: (SuppressionSpec | null)[] = [];
    if (existing.enabled) scopes.push(specOf(existing));
    if (rule.enabled) scopes.push(specOf(rule));
    analysesQueued = await queueAndDrain(orgId, scopes);
  }

  return NextResponse.json({ rule, reaudit, analysesQueued });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ ruleId: string }> },
) {
  const { ruleId } = await params;
  const orgId = await getCurrentOrgId();

  const existing = await db.query.orgRules.findFirst({
    where: and(
      eq(schema.orgRules.id, ruleId),
      eq(schema.orgRules.orgId, orgId),
    ),
  });
  if (!existing) {
    return NextResponse.json({ error: "Rule not found." }, { status: 404 });
  }

  await db.delete(schema.orgRules).where(eq(schema.orgRules.id, existing.id));

  const reaudit =
    existing.enabled && existing.suppression != null
      ? await sweepAudits(db, orgId)
      : null;

  // Deleting an enabled rule (guidance included) changes the analyst's
  // instructions; a disabled rule was already invisible to it.
  const analysesQueued = existing.enabled
    ? await queueAndDrain(orgId, [specOf(existing)])
    : 0;

  return NextResponse.json({ ok: true, reaudit, analysesQueued });
}
