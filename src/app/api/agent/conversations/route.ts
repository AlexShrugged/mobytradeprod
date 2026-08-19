import { NextResponse } from "next/server";
import { z } from "zod";

import { createConversation } from "@/lib/agent/service";
import { getAgentConversations } from "@/lib/db/queries/agent";

// Pathname only, never free text — the human-readable description the
// prompt carries is derived server-side (describePageContext).
const bodySchema = z.object({
  context: z
    .object({
      path: z.string().regex(/^\/[a-zA-Z0-9/_-]{0,200}$/),
    })
    .nullish(),
});

// The embedded widget's conversation list (the /assistant sidebar reads the
// same query as an RSC). Trimmed to what the list renders.
export async function GET() {
  const conversations = await getAgentConversations();
  return NextResponse.json({
    conversations: conversations.map((c) => ({ id: c.id, title: c.title })),
  });
}

// Open a new assistant conversation. The first message names it
// (deriveTitle); creation itself is cheap so the composer can create
// lazily on first send. The widget passes the pathname it was opened from;
// the /assistant composer sends no body.
export async function POST(request: Request) {
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // Bodyless POST (the /assistant composer) — no context.
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: z.prettifyError(parsed.error) },
      { status: 400 },
    );
  }
  const conversation = await createConversation({
    contextPath: parsed.data.context?.path ?? null,
  });
  return NextResponse.json({ conversation }, { status: 201 });
}
