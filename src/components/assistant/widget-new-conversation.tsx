"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ArrowUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// The widget's fresh composer: sibling of new-conversation-composer.tsx
// minus the navigation - the panel switches to its thread view instead.
// The pathname captured at send time is what the user is actually looking
// at; the server derives the prompt description from it.
export function WidgetNewConversation({
  configured,
  onCreated,
}: {
  configured: boolean;
  onCreated: (conversationId: string) => void;
}) {
  const pathname = usePathname();
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function start() {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/agent/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: { path: pathname } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to start the conversation.");
      }
      const { conversation } = (await res.json()) as {
        conversation: { id: string };
      };
      sessionStorage.setItem(`assistant:draft:${conversation.id}`, content);
      onCreated(conversation.id);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to start the conversation.",
      );
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <div className="flex h-full flex-col justify-end p-3">
        <div className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
          Assistant unavailable. Set ANTHROPIC_API_KEY to enable it.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col justify-end gap-3 p-3">
      <p className="text-sm text-muted-foreground">
        Ask about this page or anything else.
      </p>
      <div className="flex items-center gap-2">
        <Textarea
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
          placeholder="Write a message..."
          rows={2}
          disabled={busy}
          className="max-h-48 border-border bg-field dark:bg-field"
        />
        {text.trim() !== "" || busy ? (
          <Button
            size="icon"
            onClick={() => void start()}
            disabled={busy}
            aria-label="Send"
          >
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
