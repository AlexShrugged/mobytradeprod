"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft, Sparkles, X } from "lucide-react";

import { WidgetConversationList } from "@/components/assistant/widget-conversation-list";
import { WidgetNewConversation } from "@/components/assistant/widget-new-conversation";
import { WidgetThread } from "@/components/assistant/widget-thread";
import { onAssistantOpen } from "@/components/assistant/widget-bus";
import { Button } from "@/components/ui/button";

// The embedded MobyAI panel: a bottom-right launcher on org-facing pages
// opening a compact chat anchored above the page (never a modal - the point
// is reading the variance behind it while chatting). Opening always starts
// a fresh composer; the back chevron lists prior conversations. Mounted in
// the root layout, so panel state survives navigation and router.refresh().
// z-40 sits level with the sticky header and under shadcn dialogs (z-50).

type View =
  | { kind: "new" }
  | { kind: "list" }
  | { kind: "thread"; id: string; fresh: boolean };

// /assistant already IS the chat; /admin is the operator surface; the auth
// routes stand alone (same list as top-nav's NAVLESS_ROUTES).
const HIDDEN_PREFIXES = [
  "/assistant",
  "/admin",
  "/sign-in",
  "/sign-up",
  "/org-selection",
];

export function AssistantWidget({ configured }: { configured: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<View>({ kind: "new" });
  // Composer prompt-line override for a programmatic open (the variance
  // card's chat button); the launcher path always resets to the default.
  const [subtitle, setSubtitle] = React.useState<string | null>(null);

  React.useEffect(
    () =>
      onAssistantOpen((detail) => {
        setSubtitle(detail.subtitle ?? null);
        setView({ kind: "new" });
        setOpen(true);
      }),
    [],
  );

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  if (!open) {
    return (
      <Button
        size="icon"
        className="fixed bottom-4 right-4 z-40 size-11 rounded-full shadow-lg"
        aria-label="Open MobyAI"
        onClick={() => {
          setSubtitle(null);
          setView({ kind: "new" });
          setOpen(true);
        }}
      >
        <Sparkles className="size-5" />
      </Button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex h-[min(600px,calc(100dvh-5rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-lg">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        {view.kind !== "list" ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Conversations"
            onClick={() => setView({ kind: "list" })}
          >
            <ChevronLeft className="size-4" />
          </Button>
        ) : (
          <span className="size-7" />
        )}
        <span className="flex-1 text-center text-sm font-semibold">MobyAI</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close MobyAI"
          onClick={() => setOpen(false)}
        >
          <X className="size-4" />
        </Button>
      </div>
      {view.kind === "new" ? (
        <WidgetNewConversation
          configured={configured}
          subtitle={subtitle}
          onCreated={(id) => setView({ kind: "thread", id, fresh: true })}
        />
      ) : view.kind === "list" ? (
        <WidgetConversationList
          onSelect={(id) => setView({ kind: "thread", id, fresh: false })}
          onNew={() => {
            setSubtitle(null);
            setView({ kind: "new" });
          }}
        />
      ) : (
        // No bottom padding: AgentChat's sticky composer footer owns it,
        // so the composer pins flush to the panel's bottom edge.
        <div className="flex-1 overflow-y-auto px-3 pt-3">
          <WidgetThread
            key={view.id}
            conversationId={view.id}
            fresh={view.fresh}
            configured={configured}
          />
        </div>
      )}
    </div>
  );
}
