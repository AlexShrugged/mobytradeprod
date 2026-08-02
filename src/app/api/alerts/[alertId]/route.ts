import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

const patchBody = z.object({
  status: z.enum(["open", "resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(1).optional(),
});

// Human resolution of an audit alert. The auditor never touches
// resolved/dismissed rows, so this judgment survives re-ingestion; setting
// an alert back to "open" hands it back to the auditor.
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
    return NextResponse.json({ error: "Alert not found." }, { status: 404 });
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
