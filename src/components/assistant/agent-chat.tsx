"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBlocks } from "@/components/assistant/markdown-blocks";
import { ProposalCard } from "@/components/assistant/proposal-card";
import { ToolChip } from "@/components/assistant/tool-chip";
import { condensedToolLabel, type ToolCallView } from "@/lib/agent/display";
import { parseEventLine } from "@/lib/agent/protocol";
import type {
  AgentEvent,
  AgentProposalView,
  DisplayMessage,
} from "@/lib/agent/types";

// The thread client. Sends a turn as POST + NDJSON stream and renders the
// events live; the server persists everything as it goes, so when the
// stream settles a router.refresh() swaps the live block for the durable
// thread. Stop aborts only the fetch - the turn finishes server-side.
//
// Both the live and durable paths flatten into ThreadItems so they group
// (and therefore render) identically: a run of same-tool calls condenses
// into one chip ("Read 11 entries"); a lone call keeps its detailed label.

type LiveSegment =
  | { kind: "text"; text: string }
  | ({ kind: "tool"; callId: number } & ToolCallView)
  | { kind: "proposal"; proposal: AgentProposalView };

type ThreadItem =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "tools"; calls: ToolCallView[] }
  | { key: string; kind: "proposal"; proposal: AgentProposalView };

// Merge a call into a trailing run of the same tool. Failed calls stay
// solo so an error never hides inside a condensed chip.
function appendToolCall(items: ThreadItem[], call: ToolCallView, key: string) {
  const last = items[items.length - 1];
  if (
    last?.kind === "tools" &&
    last.calls[0].name === call.name &&
    last.calls[0].ok !== false &&
    call.ok !== false
  ) {
    last.calls.push(call);
  } else {
    items.push({ key, kind: "tools", calls: [call] });
  }
}

type LiveTurn = {
  active: boolean;
  userText: string | null;
  userMessageId: string | null;
  segments: LiveSegment[];
};

const IDLE: LiveTurn = {
  active: false,
  userText: null,
  userMessageId: null,
  segments: [],
};

export function AgentChat({
  conversationId,
  title,
  messages,
  proposals,
  turnInFlight,
  configured,
}: {
  conversationId: string;
  title: string;
  messages: DisplayMessage[];
  proposals: AgentProposalView[];
  turnInFlight: boolean;
  configured: boolean;
}) {
  const router = useRouter();
  const [live, setLive] = React.useState<LiveTurn>(IDLE);
  const [turnError, setTurnError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  // Model-generated title streamed on the first turn; the refresh at stream
  // end makes the server prop authoritative again.
  const [liveTitle, setLiveTitle] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);

  const messageIds = React.useMemo(
    () => new Set(messages.map((m) => m.id)),
    [messages],
  );
  // Once the refresh lands the persisted turn, the live block yields to it
  // in the SAME render (no flash) and the state resets - the render-time
  // adjustment pattern, not an effect.
  const liveVisible =
    live.userText !== null &&
    (live.userMessageId === null || !messageIds.has(live.userMessageId));
  if (!live.active && live.userMessageId && messageIds.has(live.userMessageId)) {
    setLive(IDLE);
  }

  React.useEffect(() => {
    if (live.segments.length > 0 || live.userText) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [live.segments.length, live.userText]);

  const handleEvent = React.useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "turn_started":
        setLive((l) => ({ ...l, userMessageId: event.userMessageId }));
        break;
      case "text_delta":
        setLive((l) => {
          const segments = [...l.segments];
          const last = segments[segments.length - 1];
          if (last?.kind === "text") {
            segments[segments.length - 1] = {
              kind: "text",
              text: last.text + event.delta,
            };
          } else {
            segments.push({ kind: "text", text: event.delta });
          }
          return { ...l, segments };
        });
        break;
      case "tool_started":
        setLive((l) => ({
          ...l,
          segments: [
            ...l.segments,
            {
              kind: "tool",
              callId: event.callId,
              name: event.name,
              summary: event.summary,
              result: null,
              ok: null,
            },
          ],
        }));
        break;
      case "tool_finished":
        setLive((l) => ({
          ...l,
          segments: l.segments.map((s) =>
            s.kind === "tool" && s.callId === event.callId
              ? { ...s, ok: event.ok, result: event.summary || null }
              : s,
          ),
        }));
        break;
      case "proposal":
        setLive((l) => ({
          ...l,
          segments: [
            ...l.segments,
            { kind: "proposal", proposal: event.proposal },
          ],
        }));
        break;
      case "title":
        setLiveTitle(event.title);
        break;
      case "error":
        setTurnError(event.message);
        break;
      default:
        // message_final, turn_done, heartbeat - the refresh at stream end
        // reconciles everything durable.
        break;
    }
  }, []);

  const send = React.useCallback(
    async (content: string) => {
      setTurnError(null);
      setLive({
        active: true,
        userText: content,
        userMessageId: null,
        segments: [],
      });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(
          `/api/agent/conversations/${conversationId}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
            signal: controller.signal,
          },
        );
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null);
          toast.error(body?.error ?? "Failed to send.");
          setLive(IDLE);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const event = parseEventLine(line);
            if (event) handleEvent(event);
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          toast.error(err instanceof Error ? err.message : "Stream failed.");
        }
      } finally {
        abortRef.current = null;
        setLive((l) => ({ ...l, active: false }));
        router.refresh();
      }
    },
    [conversationId, handleEvent, router],
  );

  // Auto-send the draft stashed by the new-conversation composer. Removing
  // the key first makes dev strict-mode double-invocation a no-op; the
  // microtask keeps setState out of the effect's synchronous path.
  React.useEffect(() => {
    const key = `assistant:draft:${conversationId}`;
    const stashed = sessionStorage.getItem(key);
    if (stashed && messages.length === 0 && !turnInFlight && configured) {
      sessionStorage.removeItem(key);
      queueMicrotask(() => void send(stashed));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = live.active || (turnInFlight && !liveVisible);

  function submit() {
    const content = draft.trim();
    if (!content || busy || !configured) return;
    setDraft("");
    void send(content);
  }

  const proposalsByMessage = React.useMemo(() => {
    const map = new Map<string, AgentProposalView[]>();
    const trailing: AgentProposalView[] = [];
    for (const p of proposals) {
      if (p.messageId && messageIds.has(p.messageId)) {
        const bucket = map.get(p.messageId);
        if (bucket) bucket.push(p);
        else map.set(p.messageId, [p]);
      } else {
        trailing.push(p);
      }
    }
    return { map, trailing };
  }, [proposals, messageIds]);

  // Durable thread flattened across message boundaries, so a tool run split
  // over several assistant messages still condenses into one chip - the
  // same grouping the live stream produces.
  const threadItems = React.useMemo(() => {
    const items: ThreadItem[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const text = m.blocks
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n");
        items.push({ key: m.id, kind: "user", text });
      } else {
        m.blocks.forEach((block, i) => {
          if (block.type === "text") {
            items.push({ key: `${m.id}:${i}`, kind: "text", text: block.text });
          } else {
            appendToolCall(items, block, `${m.id}:${i}`);
          }
        });
      }
      for (const p of proposalsByMessage.map.get(m.id) ?? []) {
        items.push({ key: p.id, kind: "proposal", proposal: p });
      }
    }
    return items;
  }, [messages, proposalsByMessage]);

  const liveItems: ThreadItem[] = [];
  if (liveVisible) {
    live.segments.forEach((s, i) => {
      if (s.kind === "text") {
        liveItems.push({ key: `live:${i}`, kind: "text", text: s.text });
      } else if (s.kind === "proposal") {
        liveItems.push({
          key: s.proposal.id,
          kind: "proposal",
          proposal: s.proposal,
        });
      } else {
        appendToolCall(liveItems, s, `live:${i}`);
      }
    });
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="truncate text-center text-base font-semibold">
        {liveTitle ?? title}
      </h1>

      <div className="space-y-4">
        {threadItems.map((item) => (
          <ThreadItemView key={item.key} item={item} />
        ))}
        {!liveVisible
          ? proposalsByMessage.trailing.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))
          : null}

        {liveVisible ? (
          <>
            <UserBubble text={live.userText ?? ""} />
            {liveItems.map((item) => (
              <ThreadItemView key={item.key} item={item} />
            ))}
            {live.active ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Working
              </div>
            ) : null}
          </>
        ) : null}
        {turnInFlight && !liveVisible && !live.active ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> A turn is running.
            Refresh to catch up.
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {turnError ? (
        <div className="rounded-md border border-red-300/60 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-400/30 dark:bg-red-950/40 dark:text-red-300">
          {turnError}
        </div>
      ) : null}

      {!configured ? (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
          Assistant unavailable. Set ANTHROPIC_API_KEY to enable it.
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Write a message..."
            rows={2}
            disabled={busy}
            className="max-h-48 border-border bg-field dark:bg-field"
          />
          {live.active ? (
            <Button
              variant="outline"
              size="icon"
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop"
              title="Stops rendering; the turn finishes in the background"
            >
              <Square />
            </Button>
          ) : draft.trim() !== "" ? (
            <Button
              size="icon"
              onClick={submit}
              disabled={busy}
              aria-label="Send"
            >
              <ArrowUp />
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  // A step lighter than the page ground (bg-popover: white / raised dark),
  // bordered so it reads as a bubble on both themes.
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-xs">
        {text}
      </div>
    </div>
  );
}

function ThreadItemView({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} />;
    case "text":
      return <MarkdownBlocks text={item.text} />;
    case "tools":
      return <ToolChipLine calls={item.calls} />;
    case "proposal":
      return <ProposalCard proposal={item.proposal} />;
  }
}

// A lone call keeps its detailed label ("Entry detail · Entry 231-..."); a
// run condenses to one chip ("Read 11 entries") with per-call hover text.
function ToolChipLine({ calls }: { calls: ToolCallView[] }) {
  if (calls.length === 1) {
    const c = calls[0];
    return (
      <div>
        <ToolChip summary={c.summary} result={c.result} ok={c.ok} />
      </div>
    );
  }
  return (
    <div>
      <ToolChip
        summary={condensedToolLabel(calls[0].name, calls.length)}
        result={null}
        ok={calls.some((c) => c.ok === null) ? null : true}
        detail={calls
          .map((c) => (c.result ? `${c.summary} · ${c.result}` : c.summary))
          .join("\n")}
      />
    </div>
  );
}
