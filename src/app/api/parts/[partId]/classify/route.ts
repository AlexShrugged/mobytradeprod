import { NextResponse } from "next/server";

import { classifyPart } from "@/lib/classification/service";
import { db } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

// Run the classifier for one part and (re)queue its review item. The
// Claude classifier can take up to its 120s deadline; keep the function
// alive well past it (same allowance as the entry analyze route).
export const maxDuration = 800;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ partId: string }> },
) {
  const { partId } = await params;
  const orgId = await getCurrentOrgId();

  const result = await db.transaction((tx) => classifyPart(tx, orgId, partId));
  if (!result) {
    return NextResponse.json({ error: "Part not found." }, { status: 404 });
  }

  return NextResponse.json({
    classification: result.classification,
    reviewItem: result.reviewItem,
  });
}
