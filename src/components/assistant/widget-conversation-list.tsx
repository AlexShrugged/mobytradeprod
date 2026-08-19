"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// The widget's back view: prior conversations, newest first (same query as
// the /assistant sidebar, via the GET route). Expected to be rarely used -
// kept minimal.
export function WidgetConversationList({
  onSelect,
  onNew,
}: {
  onSelect: (conversationId: string) => void;
  onNew: () => void;
}) {
  const [conversations, setConversations] = React.useState<
    { id: string; title: string }[] | null
  >(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/agent/conversations")
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json().catch(() => null)) as {
          conversations?: { id: string; title: string }[];
        } | null;
        if (!cancelled && payload?.conversations) {
          setConversations(payload.conversations);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <Button size="sm" className="w-full" onClick={onNew}>
        <Plus /> New
      </Button>
      <div className="flex-1 space-y-0.5 overflow-y-auto">
        {conversations === null ? (
          <div className="space-y-2 pt-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No conversations yet
          </p>
        ) : (
          conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {c.title}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
