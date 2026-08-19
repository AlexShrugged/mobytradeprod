import { NextResponse } from "next/server";
import { z } from "zod";

import {
  decideProposal,
  ProposalStateError,
} from "@/lib/agent/service";

// Record the human's call on a proposal card. Confirm EXECUTION happens
// client-side against the existing decision routes (PATCH /api/alerts/:id
// per unit id, POST /api/entries/:id/analyze) - this endpoint only records
// the card's outcome, keeping those routes the single write paths.
const patchBody = z.object({
  status: z.enum(["confirmed", "dismissed"]),
  results: z
    .array(z.object({ id: z.string(), ok: z.boolean() }))
    .nullable()
    .optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ proposalId: string }> },
) {
  const { proposalId } = await params;

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

  try {
    const proposal = await decideProposal(proposalId, {
      status: parsed.data.status,
      results: parsed.data.results ?? null,
    });
    if (!proposal) {
      return NextResponse.json(
        { error: "Proposal not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ proposal });
  } catch (err) {
    if (err instanceof ProposalStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
