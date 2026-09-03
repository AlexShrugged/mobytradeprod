import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";
import { dismissReconsiderItem, QuoteStateError } from "@/lib/quotes/service";

const bodySchema = z.object({
  action: z.literal("dismiss"),
  note: z.string().nullish(),
});

// Dismiss a quote_reconsider item: the human looked at the moved ranking
// and keeps the current sourcing. Taking the cheaper quote goes through the
// quote-line decide route instead — approving any quote on the part
// resolves the item.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await params;
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

  try {
    const decidedBy = await getCurrentActorName();
    const item = await db.transaction((tx) =>
      dismissReconsiderItem(
        tx,
        orgId,
        itemId,
        decidedBy,
        parsed.data.note ?? undefined,
      ),
    );
    if (!item) {
      return NextResponse.json({ error: "Item not found." }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (err) {
    if (err instanceof QuoteStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
