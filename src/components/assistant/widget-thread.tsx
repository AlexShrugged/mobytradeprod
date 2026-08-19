"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { AgentChat } from "@/components/assistant/agent-chat";
import { AssistantRefreshProvider } from "@/components/assistant/refresh-context";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentProposalView, DisplayMessage } from "@/lib/agent/types";

// The widget's data seam: /assistant feeds AgentChat from RSC props; the
// panel feeds it from the thread GET route. The refresh override refetches
// this thread AND router.refresh()es the page behind the panel, so a
// proposal confirm reconciles both without closing anything.

type ThreadData = {
  conversationId: string;
  title: string;
  messages: DisplayMessage[];
  proposals: AgentProposalView[];
  turnInFlight: boolean;
};

export function WidgetThread({
  conversationId,
  fresh,
  configured,
}: {
  conversationId: string;
  /** Just created by the widget composer: skip the initial fetch and let
   *  AgentChat's stashed-draft auto-send run against an empty thread. */
  fresh: boolean;
  configured: boolean;
}) {
  const router = useRouter();
  const [thread, setThread] = React.useState<ThreadData | null>(
    fresh
      ? {
          conversationId,
          title: "New conversation",
          messages: [],
          proposals: [],
          turnInFlight: false,
        }
      : null,
  );

  const refetch = React.useCallback(async () => {
    const res = await fetch(`/api/agent/conversations/${conversationId}`);
    if (!res.ok) return;
    const payload = (await res.json().catch(() => null)) as {
      thread?: ThreadData;
    } | null;
    if (payload?.thread) setThread(payload.thread);
  }, [conversationId]);

  // Microtask keeps setState out of the effect's synchronous path (the
  // agent-chat auto-send precedent).
  React.useEffect(() => {
    if (!fresh) queueMicrotask(() => void refetch());
  }, [fresh, refetch]);

  // Reconnect case: the panel opened onto a turn still running server-side
  // (kept alive by after()). There is no stream to rejoin - poll until the
  // lock clears; turns persist incrementally, so each poll shows progress.
  const turnInFlight = thread?.turnInFlight ?? false;
  React.useEffect(() => {
    if (!turnInFlight) return;
    const id = setInterval(() => void refetch(), 5_000);
    return () => clearInterval(id);
  }, [turnInFlight, refetch]);

  const refreshBoth = React.useMemo(
    () => () => {
      void refetch();
      router.refresh();
    },
    [refetch, router],
  );

  if (!thread) {
    return (
      <div className="space-y-3 p-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }

  return (
    <AssistantRefreshProvider value={refreshBoth}>
      <AgentChat
        conversationId={thread.conversationId}
        title={thread.title}
        messages={thread.messages}
        proposals={thread.proposals}
        turnInFlight={thread.turnInFlight}
        configured={configured}
      />
    </AssistantRefreshProvider>
  );
}
