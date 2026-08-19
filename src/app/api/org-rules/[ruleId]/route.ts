import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { sweepAudits } from "@/lib/audit/auditor";
import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import {
  sameSuppressionSemantics,
  suppressionSpecSchema,
} from "@/lib/org-rules";

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

  return NextResponse.json({ rule, reaudit });
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

  return NextResponse.json({ ok: true, reaudit });
}
