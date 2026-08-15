import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

const patchBody = z.object({
  status: z.enum(["open", "resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(1).optional(),
});

// Human resolution of an AI analysis finding — the exact contract of the
// audit-alert route: re-analysis never touches resolved/dismissed rows, so
// this judgment survives; setting a finding back to "open" hands it back to
// the analyst's reconcile pass.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const { findingId } = await params;
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

  const finding = await db.query.analysisFindings.findFirst({
    where: and(
      eq(schema.analysisFindings.id, findingId),
      eq(schema.analysisFindings.orgId, orgId),
    ),
  });
  if (!finding) {
    return NextResponse.json({ error: "Finding not found." }, { status: 404 });
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
