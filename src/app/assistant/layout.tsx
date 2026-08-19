import type { Metadata } from "next";

import { ConversationSidebar } from "@/components/assistant/conversation-sidebar";
import { getAgentConversations } from "@/lib/db/queries/agent";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "MobyAI" };

// Two panes: every conversation openable from the left, the active thread
// (or the new-conversation composer) on the right.
export default async function AssistantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const conversations = await getAgentConversations();
  return (
    <div className="flex min-h-[calc(100vh-6.5rem)] gap-4 md:gap-6">
      <ConversationSidebar
        conversations={conversations.map((c) => ({ id: c.id, title: c.title }))}
      />
      <div className="hidden w-px self-stretch bg-border md:block" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
