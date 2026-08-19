import { describe, expect, it } from "vitest";

import { ClaudeAgent } from "./claude";
import type {
  AgentClient,
  AgentEvent,
  AgentTurnInput,
  PersistedMessageRef,
  RunnerStreamLike,
} from "./types";

type Scripted = {
  deltas?: string[];
  final: {
    stop_reason: string | null;
    usage?: Record<string, number>;
  };
  /** Wire messages the "runner" appends AFTER this iteration's stream is
   *  consumed (assistant message + tool results), like the real SDK. */
  appendAfter?: { role: string; content: unknown }[];
  throwBefore?: boolean;
};

function fakeClient(
  iterations: Scripted[],
  title?: { text: string } | { throw: true },
): AgentClient {
  return {
    messages: {
      create: async () => {
        if (title && "throw" in title) throw new Error("title boom");
        return { content: [{ type: "text", text: title?.text ?? "" }] };
      },
    },
    beta: {
      messages: {
        toolRunner(params: Record<string, unknown>) {
          const messages = params.messages as unknown[];
          return {
            params: { messages },
            async *[Symbol.asyncIterator](): AsyncIterator<RunnerStreamLike> {
              for (const it of iterations) {
                if (it.throwBefore) {
                  throw new Error("The operation was aborted");
                }
                const stream: RunnerStreamLike = {
                  on(event, listener) {
                    if (event === "text") {
                      for (const d of it.deltas ?? []) listener(d);
                    }
                    return stream;
                  },
                  finalMessage: async () => it.final,
                };
                yield stream;
                for (const m of it.appendAfter ?? []) messages.push(m);
              }
            },
          };
        },
      },
    },
  };
}

function makeInput(over: Partial<AgentTurnInput> = {}) {
  const events: AgentEvent[] = [];
  const persisted: { role: string; content: unknown }[] = [];
  const attached: { ids: string[]; messageId: string }[] = [];
  let seq = 1;
  const input: AgentTurnInput = {
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    tools: [],
    sink: { emit: (e) => events.push(e) },
    signal: new AbortController().signal,
    persistNewMessages: async (msgs): Promise<PersistedMessageRef[]> =>
      msgs.map((m) => {
        persisted.push(m);
        seq += 1;
        return {
          id: `m${seq}`,
          seq,
          role: m.role,
          content: m.content,
          createdAt: new Date("2026-08-18T00:00:00Z"),
        };
      }),
    attachProposals: async (ids, messageId) => {
      attached.push({ ids, messageId });
    },
    pendingProposalIds: [],
    ...over,
  };
  return { input, events, persisted, attached };
}

describe("ClaudeAgent", () => {
  it("streams deltas, persists appended wire messages, and sums usage", async () => {
    const client = fakeClient([
      {
        final: {
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 90 },
        },
        appendAfter: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "get_entry", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }],
          },
        ],
      },
      {
        deltas: ["All ", "done."],
        final: {
          stop_reason: "end_turn",
          usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 90 },
        },
        appendAfter: [
          { role: "assistant", content: [{ type: "text", text: "All done." }] },
        ],
      },
    ]);
    const { input, events, persisted } = makeInput();
    const agent = new ClaudeAgent({ client, model: "test-model" });
    const result = await agent.runTurn(input);

    expect(result.error).toBeNull();
    expect(result.usage).toEqual({
      iterations: 2,
      inputTokens: 140,
      outputTokens: 30,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 90,
    });
    expect(persisted.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    const deltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.delta : ""));
    expect(deltas.join("")).toBe("All done.");
    // Displayable messages got message_final events (tool_result plumbing
    // rows do not).
    const finals = events.filter((e) => e.type === "message_final");
    expect(finals).toHaveLength(2);
  });

  it("anchors pending proposals to the persisted assistant message", async () => {
    const client = fakeClient([
      {
        final: { stop_reason: "end_turn" },
        appendAfter: [
          { role: "assistant", content: [{ type: "text", text: "proposed" }] },
        ],
      },
    ]);
    const { input, attached } = makeInput({ pendingProposalIds: ["p1", "p2"] });
    await new ClaudeAgent({ client, model: "test-model" }).runTurn(input);
    expect(attached).toEqual([{ ids: ["p1", "p2"], messageId: "m2" }]);
    expect(input.pendingProposalIds).toEqual([]);
  });

  it("records a refusal as the turn error", async () => {
    const client = fakeClient([{ final: { stop_reason: "refusal" } }]);
    const { input } = makeInput();
    const result = await new ClaudeAgent({ client, model: "test-model" }).runTurn(
      input,
    );
    expect(result.error).toContain("refusal");
  });

  it("sanitizes the generated title", async () => {
    const client = fakeClient([], { text: '  "Open variance review."  ' });
    const agent = new ClaudeAgent({ client, model: "test-model" });
    await expect(agent.generateTitle("question")).resolves.toBe(
      "Open variance review",
    );
  });

  it("returns a null title on failure and on empty output", async () => {
    const failing = new ClaudeAgent({
      client: fakeClient([], { throw: true }),
      model: "test-model",
    });
    await expect(failing.generateTitle("question")).resolves.toBeNull();
    const empty = new ClaudeAgent({
      client: fakeClient([], { text: "  " }),
      model: "test-model",
    });
    await expect(empty.generateTitle("question")).resolves.toBeNull();
  });

  it("keeps earlier persisted work when a later iteration throws", async () => {
    const client = fakeClient([
      {
        final: { stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 2 } },
        appendAfter: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "get_entry", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }],
          },
        ],
      },
      { final: { stop_reason: "end_turn" }, throwBefore: true },
    ]);
    const { input, persisted } = makeInput();
    const result = await new ClaudeAgent({ client, model: "test-model" }).runTurn(
      input,
    );
    expect(result.error).toContain("aborted");
    expect(persisted).toHaveLength(2);
    expect(result.usage.iterations).toBe(1);
  });
});
