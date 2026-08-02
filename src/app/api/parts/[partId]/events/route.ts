import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getEvents } from "@/lib/db/queries/events";
import { getCurrentOrgId } from "@/lib/org";

// The Parts-row history: the same derived feed as /events, scoped to one
// SKU. Fetched lazily when a row expands — assembling every part's feed up
// front would run the assembler N times for rows nobody opens.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ partId: string }> },
) {
  const { partId } = await params;
  const orgId = await getCurrentOrgId();

  const part = await db.query.parts.findFirst({
    where: and(eq(schema.parts.id, partId), eq(schema.parts.orgId, orgId)),
    columns: { id: true },
  });
  if (!part) {
    return NextResponse.json({ error: "Part not found." }, { status: 404 });
  }

  const events = await getEvents({ partId, limit: 8 });
  return NextResponse.json({ events });
}
