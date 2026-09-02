import { NextResponse } from "next/server";
import { z } from "zod";

import { sweepAudits } from "@/lib/audit/auditor";
import { db, schema } from "@/lib/db";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";
import {
  loadOrgRules,
  suppressionSpecSchema,
  type SuppressionSpec,
} from "@/lib/org-rules";

import { scheduleRuleReanalysis } from "./schedule";

// The after() re-analysis work (a Claude scoping call, then a drain of up
// to three investigations at a 600s analyst deadline each) must outlive
// the response. Default 300s killed the drain mid-run and orphaned the
// queue (2026-09-01).
export const maxDuration = 800;

const bodySchema = z.object({
  text: z.string().trim().min(1).max(300),
  suppression: suppressionSpecSchema.nullish(),
  source: z.enum(["manual", "assistant"]).default("manual"),
});

export async function GET() {
  const orgId = await getCurrentOrgId();
  const rules = await loadOrgRules(db, orgId);
  return NextResponse.json({ rules });
}

// The single write path for new org rules: the Settings page add dialog and the
// assistant's confirmed save_org_rule card both POST here. A suppression
// rule re-sweeps the org synchronously so the response carries the cleared
// count; a sweep that dies heals on the next one (alert_key idempotency).
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

  const actor = await getCurrentActorName();
  const [rule] = await db
    .insert(schema.orgRules)
    .values({
      orgId,
      text: input.text,
      suppression: input.suppression ?? null,
      source: input.source,
      createdByName: actor,
    })
    .returning();

  const reaudit = rule.suppression ? await sweepAudits(db, orgId) : null;

  // Rule alerts cleared synchronously above; AI findings need real model
  // runs, so they queue after the response — scoped to the entries the
  // rule can touch (the deterministic floor in rule-relevance.ts plus the
  // Claude scoping pass in rule-scope.ts) and drained, the tariff-apply
  // pattern. Guidance rules queue too: every enabled rule reaches the
  // analyst's prompt. analysesQueued null = pending, decided in after().
  scheduleRuleReanalysis(orgId, {
    before: null,
    after: {
      text: rule.text,
      suppression: (rule.suppression as SuppressionSpec | null) ?? null,
    },
  });

  return NextResponse.json(
    { rule, reaudit, analysesQueued: null },
    { status: 201 },
  );
}
