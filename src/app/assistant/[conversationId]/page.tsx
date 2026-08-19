import { notFound } from "next/navigation";

import { AgentChat } from "@/components/assistant/agent-chat";
import { isAgentConfigured } from "@/lib/agent";
import { getAgentThread } from "@/lib/db/queries/agent";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const thread = await getAgentThread(conversationId);
  if (!thread) notFound();

  return (
    <AgentChat
      conversationId={thread.conversation.id}
      title={thread.conversation.title}
      messages={thread.messages}
      proposals={thread.proposals}
      turnInFlight={thread.turnInFlight}
      configured={isAgentConfigured()}
    />
  );
}
