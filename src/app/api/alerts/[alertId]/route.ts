import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

const patchBody = z.object({
  status: z.enum(["open", "resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(1).optional(),
});

// Human resolution of a variance-queue row. The id is usually an audit
// alert; when it isn't, the AI analysis finding with that id decides here
// instead — the reconciliation flow (auto-advance, undo) works whole lines
// whose units mix both kinds, through this one endpoint. Writers never
// touch resolved/dismissed rows, so the judgment survives re-ingestion and
// re-analysis alike; setting a row back to "open" hands it back to its
// writer.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ alertId: string }> },
) {
  const { alertId } = await params;
  const orgId = await getCurrentOrgId();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = patchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body." },
      { status: 400 },
    );
  }
  const { status, resolutionNote } = parsed.data;

  const alert = await db.query.auditAlerts.findFirst({
    where: and(
      eq(schema.auditAlerts.id, alertId),
      eq(schema.auditAlerts.orgId, orgId),
    ),
  });
  if (!alert) {
    const finding = await db.query.analysisFindings.findFirst({
      where: and(
        eq(schema.analysisFindings.id, alertId),
        eq(schema.analysisFindings.orgId, orgId),
      ),
    });
    if (!finding) {
      return NextResponse.json({ error: "Alert not found." }, { status: 404 });
    }
    const [updated] = await db
      .update(schema.analysisFindings)
      .set({
        status,
        resolvedAt: status === "open" ? null : new Date(),
        resolutionNote: status === "open" ? null : (resolutionNote ?? null),
        updatedAt: new Date(),
      })
      .where(eq(schema.analysisFindings.id, finding.id))
      .returning();
    return NextResponse.json({ finding: updated });
  }

  const [updated] = await db
    .update(schema.auditAlerts)
    .set({
      status,
      resolvedAt: status === "open" ? null : new Date(),
      resolutionNote: status === "open" ? null : (resolutionNote ?? null),
      updatedAt: new Date(),
    })
    .where(eq(schema.auditAlerts.id, alert.id))
    .returning();

  return NextResponse.json({ alert: updated });
}
