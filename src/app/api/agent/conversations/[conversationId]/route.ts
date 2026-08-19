import { NextResponse } from "next/server";

import { getAgentThread } from "@/lib/db/queries/agent";

// Thread fetch for the embedded widget (the /assistant page reads the same
// query as an RSC). DisplayMessage/AgentProposalView already carry string
// dates — JSON-safe as-is; the raw conversation row stays off the wire.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  const thread = await getAgentThread(conversationId);
  if (!thread) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }
  return NextResponse.json({
    thread: {
      conversationId: thread.conversation.id,
      title: thread.conversation.title,
      messages: thread.messages,
      proposals: thread.proposals,
      turnInFlight: thread.turnInFlight,
    },
  });
}
