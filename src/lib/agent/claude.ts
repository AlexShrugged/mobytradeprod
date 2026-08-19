// Claude-backed assistant turn: the SDK tool runner in streaming mode
// drives one conversational turn over the assistant tools. Each iteration
// yields a message stream - text deltas go to the sink as they arrive, and
// every wire message the runner accumulates persists incrementally (by
// index diff against runner.params.messages), so a dropped client or a
// mid-turn crash loses nothing already produced. Never throws - the turn
// result carries the error and the conversation stays usable.

import Anthropic from "@anthropic-ai/sdk";

import { sanitizeTitle } from "./conversation";
import { collectToolResults, toDisplayMessage } from "./display";
import type {
  AgentClient,
  AgentRunner,
  AgentTurnInput,
  AgentTurnResult,
  AgentUsage,
} from "./types";

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_DEADLINE_MS = 300_000;
const DEFAULT_MAX_ITERATIONS = 20;
const MAX_TOKENS = 16_000;

// Conversation titling: one small non-streaming call, raced against the
// first turn (service.ts). Adaptive thinking spends against max_tokens on
// this model family, so the cap leaves headroom beyond the title itself.
const TITLE_MAX_TOKENS = 512;
const TITLE_TIMEOUT_MS = 15_000;
const TITLE_SYSTEM =
  "Title a new conversation from its first user message. 3 to 8 words, sentence case. No quotes, no trailing period, no em dashes. Respond with the title only.";

export class ClaudeAgent implements AgentRunner {
  private readonly client: AgentClient;
  readonly model: string;
  private readonly titleModel: string;
  private readonly deadlineMs: number;
  private readonly maxIterations: number;

  constructor(
    opts: {
      client?: AgentClient;
      model?: string;
      titleModel?: string;
      deadlineMs?: number;
      maxIterations?: number;
    } = {},
  ) {
    this.client = opts.client ?? (new Anthropic() as unknown as AgentClient);
    this.model = opts.model ?? process.env.AGENT_MODEL ?? DEFAULT_MODEL;
    this.titleModel =
      opts.titleModel ?? process.env.AGENT_TITLE_MODEL ?? this.model;
    this.deadlineMs =
      opts.deadlineMs ??
      (Number(process.env.AGENT_DEADLINE_MS) || DEFAULT_DEADLINE_MS);
    this.maxIterations =
      opts.maxIterations ??
      (Number(process.env.AGENT_MAX_ITERATIONS) || DEFAULT_MAX_ITERATIONS);
  }

  /** Null on failure or refusal - the caller keeps its derived fallback. */
  async generateTitle(userText: string): Promise<string | null> {
    try {
      const res = await this.client.messages.create(
        {
          model: this.titleModel,
          max_tokens: TITLE_MAX_TOKENS,
          system: TITLE_SYSTEM,
          messages: [{ role: "user", content: userText.slice(0, 4_000) }],
        },
        { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
      );
      const raw = res.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ");
      return sanitizeTitle(raw);
    } catch (e) {
      console.error("assistant title generation failed:", e);
      return null;
    }
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const usage: AgentUsage = {
      iterations: 0,
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    };
    let error: string | null = null;

    const runner = this.client.beta.messages.toolRunner(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        max_iterations: this.maxIterations,
        stream: true,
        // Auto-caching: the SDK re-places the breakpoint on the last
        // cacheable block each iteration, so tools + system + history read
        // from cache from iteration 2 on (analyst precedent).
        cache_control: { type: "ephemeral" },
      },
      {
        signal: AbortSignal.any([
          input.signal,
          AbortSignal.timeout(this.deadlineMs),
        ]),
      },
    );

    // Everything past the rebuilt transcript is this turn's output. The
    // runner appends assistant messages and tool_result user messages to
    // params.messages as it goes; persist whatever is new after each
    // iteration and once more after the loop (trailing tool results land
    // between yields).
    let persistedCount = input.messages.length;
    const toolResults = new Map<string, string>();
    const persistBeyond = async () => {
      const all = runner.params.messages;
      if (all.length <= persistedCount) return;
      const fresh = all.slice(persistedCount) as {
        role: string;
        content: unknown;
      }[];
      persistedCount = all.length;
      const rows = await input.persistNewMessages(
        fresh.map((m) => ({ role: m.role, content: m.content })),
      );
      for (const [id, text] of collectToolResults(rows)) {
        toolResults.set(id, text);
      }
      for (const row of rows) {
        const display = toDisplayMessage(row, toolResults);
        if (display) {
          input.sink.emit({ type: "message_final", message: display });
        }
        if (row.role === "assistant" && input.pendingProposalIds.length > 0) {
          await input.attachProposals(
            input.pendingProposalIds.splice(0),
            row.id,
          );
        }
      }
    };

    try {
      for await (const stream of runner) {
        usage.iterations += 1;
        stream.on("text", (delta) => {
          input.sink.emit({ type: "text_delta", delta });
        });
        const message = await stream.finalMessage();
        const u = message.usage;
        if (u) {
          usage.inputTokens += u.input_tokens ?? 0;
          usage.outputTokens += u.output_tokens ?? 0;
          usage.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
          usage.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
        }
        if (message.stop_reason === "refusal") {
          error = "safety classifiers declined mid-turn (stop_reason refusal)";
          break;
        }
        await persistBeyond();
      }
    } catch (e) {
      // Deadline abort, rate limits, connection errors - the turn is
      // best-effort by contract; whatever persisted stands.
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }

    try {
      await persistBeyond();
    } catch (e) {
      error =
        error ?? (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }

    return { usage, error };
  }
}
