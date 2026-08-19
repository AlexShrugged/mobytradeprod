import { describe, expect, it } from "vitest";

import { encodeEvent, parseEventLine } from "./protocol";
import type { AgentEvent } from "./types";

describe("protocol", () => {
  it("round-trips every event shape", () => {
    const events: AgentEvent[] = [
      { type: "turn_started", userMessageId: "m1" },
      { type: "text_delta", delta: "hello " },
      { type: "title", title: "Severe variance review" },
      { type: "tool_started", callId: 1, name: "get_entry", summary: "Entry" },
      {
        type: "tool_finished",
        callId: 1,
        name: "get_entry",
        ok: true,
        summary: "Entry E-1",
      },
      {
        type: "proposal",
        proposal: {
          id: "p1",
          conversationId: "c1",
          messageId: null,
          kind: "alert_decision",
          payload: {
            kind: "alert_decision",
            targetId: "a1",
            unitIds: ["a1", "a2"],
            decision: "resolved",
            note: "why",
            entryId: "e1",
            entryNumber: "E-1",
            label: "Rate mismatch",
            impactCents: 1200,
            href: "/variance/a1",
          },
          status: "proposed",
          decidedAt: null,
          results: null,
          createdAt: "2026-08-18T00:00:00.000Z",
          liveStatuses: null,
        },
      },
      {
        type: "message_final",
        message: {
          id: "m2",
          role: "assistant",
          seq: 2,
          blocks: [
            { type: "text", text: "done" },
            {
              type: "tool_use",
              name: "get_entry",
              summary: "Entry detail",
              result: "Entry E-1",
              ok: true,
            },
          ],
          createdAt: "2026-08-18T00:00:00.000Z",
        },
      },
      {
        type: "turn_done",
        usage: {
          iterations: 2,
          inputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
        },
      },
      { type: "error", message: "boom" },
      { type: "heartbeat" },
    ];
    for (const event of events) {
      const line = encodeEvent(event);
      expect(line.endsWith("\n")).toBe(true);
      expect(parseEventLine(line)).toEqual(event);
    }
  });

  it("returns null for blank and malformed lines", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   ")).toBeNull();
    expect(parseEventLine("{not json")).toBeNull();
    expect(parseEventLine('{"type":"unknown_event"}')).toBeNull();
    expect(parseEventLine('{"type":"text_delta"}')).toBeNull();
  });
});
