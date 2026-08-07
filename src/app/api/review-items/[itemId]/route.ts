import { NextResponse } from "next/server";

import {
  applyReviewDecision,
  ReviewConflictError,
} from "@/lib/classification/service";
import type { ReviewActionInput } from "@/lib/classification/review";
import { db } from "@/lib/db";
import { getCurrentActorName, getCurrentOrgId } from "@/lib/org";

const ACTIONS = ["accept", "reject", "acknowledge", "manual", "reopen"] as const;
type Action = (typeof ACTIONS)[number];

// Decide a review-queue item: accept / reject / acknowledge / manual code /
// reopen. Commits catalog changes and re-audits affected entries in one
// transaction.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await params;
  const orgId = await getCurrentOrgId();

  let body: {
    action?: unknown;
    code?: unknown;
    notes?: unknown;
    effectiveDate?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof body.action !== "string" ||
    !ACTIONS.includes(body.action as Action)
  ) {
    return NextResponse.json(
      { error: `action must be one of: ${ACTIONS.join(", ")}` },
      { status: 400 },
    );
  }
  const action = body.action as Action;

  let input: ReviewActionInput;
  if (action === "accept" || action === "manual") {
    if (typeof body.code !== "string" || body.code.trim() === "") {
      return NextResponse.json(
        { error: `${action} requires a code.` },
        { status: 400 },
      );
    }
    input = { action, code: body.code.trim() };
  } else {
    input = { action };
  }
  const notes = typeof body.notes === "string" ? body.notes : undefined;

  // Optional: date the commit ("reclassified from this day forward");
  // absent means the code was always correct and history is corrected.
  let effectiveDate: string | null = null;
  if (body.effectiveDate != null && body.effectiveDate !== "") {
    if (
      typeof body.effectiveDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveDate)
    ) {
      return NextResponse.json(
        { error: "effectiveDate must be a YYYY-MM-DD date." },
        { status: 400 },
      );
    }
    effectiveDate = body.effectiveDate;
  }

  try {
    const actor = await getCurrentActorName();
    const result = await db.transaction((tx) =>
      applyReviewDecision(tx, orgId, itemId, input, {
        actor,
        notes,
        effectiveDate,
      }),
    );
    if (!result) {
      return NextResponse.json(
        { error: "Review item not found." },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ReviewConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof Error &&
      (err.message.startsWith("Cannot") ||
        err.message.startsWith("Invalid HTS code"))
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
