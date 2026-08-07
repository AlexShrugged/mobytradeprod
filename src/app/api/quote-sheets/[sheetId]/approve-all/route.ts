import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";
import { approveAllForSheet, QuoteStateError } from "@/lib/quotes/service";

const bodySchema = z.object({
  // Omitted → the org's default actor. Auth will supply the real user later.
  decidedBy: z.string().trim().min(1).optional(),
});

// Sheet-level convenience: approve every remaining received line.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sheetId: string }> },
) {
  const { sheetId } = await params;
  const orgId = await getCurrentOrgId();

  // The body is optional — an empty POST approves as the default actor.
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // No/invalid body: fall through to defaults.
  }
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: z.prettifyError(parsed.error) },
      { status: 400 },
    );
  }

  try {
    const decidedBy = parsed.data.decidedBy ?? (await getCurrentActorName());
    const results = await db.transaction((tx) =>
      approveAllForSheet(tx, orgId, sheetId, decidedBy),
    );
    if (!results) {
      return NextResponse.json(
        { error: "Quote sheet not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof QuoteStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
