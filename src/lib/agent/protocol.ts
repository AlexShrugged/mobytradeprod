// NDJSON wire encoding for the assistant turn stream: one JSON object per
// line, Content-Type application/x-ndjson. The client splits on newlines
// and parses each line independently; parseEventLine is lenient (null on
// junk) so a torn final line never breaks the reader loop. Pure.

import { z } from "zod";

import type { AgentEvent } from "./types";

const usageSchema = z.object({
  iterations: z.number(),
  inputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  outputTokens: z.number(),
});

const displayMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  seq: z.number(),
  blocks: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("tool_use"),
        name: z.string(),
        summary: z.string(),
        result: z.string().nullable(),
        ok: z.boolean(),
      }),
    ]),
  ),
  createdAt: z.string(),
});

const proposalViewSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string().nullable(),
  kind: z.enum(["alert_decision", "analyze_entry"]),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["proposed", "confirmed", "dismissed"]),
  decidedAt: z.string().nullable(),
  results: z.array(z.object({ id: z.string(), ok: z.boolean() })).nullable(),
  createdAt: z.string(),
  liveStatuses: z
    .record(z.string(), z.enum(["open", "resolved", "dismissed"]))
    .nullable(),
});

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn_started"), userMessageId: z.string() }),
  z.object({ type: z.literal("text_delta"), delta: z.string() }),
  z.object({ type: z.literal("title"), title: z.string() }),
  z.object({
    type: z.literal("tool_started"),
    callId: z.number(),
    name: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("tool_finished"),
    callId: z.number(),
    name: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  z.object({ type: z.literal("proposal"), proposal: proposalViewSchema }),
  z.object({
    type: z.literal("message_final"),
    message: displayMessageSchema,
  }),
  z.object({ type: z.literal("turn_done"), usage: usageSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("heartbeat") }),
]);

export function encodeEvent(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Null for blank or malformed lines — the reader skips them. */
export function parseEventLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = agentEventSchema.safeParse(raw);
  return parsed.success ? (parsed.data as AgentEvent) : null;
}
