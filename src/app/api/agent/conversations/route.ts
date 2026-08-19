import { NextResponse } from "next/server";

import { createConversation } from "@/lib/agent/service";

// Open a new assistant conversation. The first message names it
// (deriveTitle); creation itself is cheap so the composer can create
// lazily on first send.
export async function POST() {
  const conversation = await createConversation();
  return NextResponse.json({ conversation }, { status: 201 });
}
