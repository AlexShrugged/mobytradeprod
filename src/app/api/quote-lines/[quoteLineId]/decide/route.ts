import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { decideQuoteLine, QuoteStateError } from "@/lib/quotes/service";

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  // Free text until auth lands.
  decidedBy: z.string().trim().min(1).default("Alex"),
  note: z.string().nullish(),
});

// Decide one quote line. Approving a draft part's quote finalizes the SKU
// (part → active, line → applied); approving an active part's quote leaves
// it waiting for a confirming PO. Only received lines are decidable.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ quoteLineId: string }> },
) {
  const { quoteLineId } = await params;
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
  const { action, decidedBy, note } = parsed.data;

  try {
    const result = await db.transaction((tx) =>
      decideQuoteLine(tx, orgId, quoteLineId, action, decidedBy, note ?? undefined),
    );
    if (!result) {
      return NextResponse.json(
        { error: "Quote line not found." },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof QuoteStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
