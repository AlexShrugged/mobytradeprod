// Claude-backed entry analyst: the SDK tool runner drives an investigation
// loop over the nine analysis tools; report_findings is the terminal action.
// A run that ends without a report gets ONE structured-output nudge over the
// accumulated transcript; total failure degrades to the stub's deterministic
// findings with the error noted. Never throws — the eval harness (and any
// future pipeline caller) must not fail because analysis did.
//
// Relative imports on purpose — this module runs under the tsx eval script.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

import type { ReferenceData } from "../duty/types";
import { findingsReportSchema } from "./findings";
import { buildInitialUserMessage, buildSystemPrompt } from "./prompt";
import { StubEntryAnalyst } from "./stub";
import { buildAnalystTools, type ReportCollector } from "./tools";
import type {
  AnalystResult,
  AnalystUsage,
  EntryAnalyst,
  EntryBundle,
  ToolTraceEntry,
} from "./types";

const DEFAULT_MODEL = "claude-opus-5";
// 600s: at 300s, 2 of 11 first-eval runs hit the deadline on transient
// investigation-depth variance; both retries finished well under 600s.
const DEFAULT_DEADLINE_MS = 600_000;
const DEFAULT_MAX_ITERATIONS = 12;
const MAX_TOKENS = 16_000;

const NUDGE =
  "Your investigation is over. Emit your final findings report now as structured output — findings you can no longer support with evidence should be dropped, not padded.";

type RunnerMessage = {
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
};

/** The slice of the SDK client this analyst uses — injectable for tests
 *  (extractor precedent: structural typing, no module mocking). */
export interface AnalystClient {
  beta: {
    messages: {
      toolRunner(
        params: Record<string, unknown>,
        opts?: { signal?: AbortSignal },
      ): AsyncIterable<RunnerMessage> & {
        params: { messages: unknown[] };
      };
      parse(params: Record<string, unknown>): Promise<{
        parsed_output: unknown;
        stop_reason: string | null;
      }>;
    };
  };
}

export class ClaudeEntryAnalyst implements EntryAnalyst {
  private readonly client: AnalystClient;
  private readonly stub = new StubEntryAnalyst();
  readonly model: string;
  private readonly deadlineMs: number;
  private readonly maxIterations: number;

  constructor(
    opts: {
      client?: AnalystClient;
      model?: string;
      deadlineMs?: number;
      maxIterations?: number;
    } = {},
  ) {
    this.client = opts.client ?? (new Anthropic() as unknown as AnalystClient);
    this.model =
      opts.model ?? process.env.ENTRY_ANALYST_MODEL ?? DEFAULT_MODEL;
    this.deadlineMs =
      opts.deadlineMs ??
      (Number(process.env.ENTRY_ANALYST_DEADLINE_MS) || DEFAULT_DEADLINE_MS);
    this.maxIterations =
      opts.maxIterations ??
      (Number(process.env.ENTRY_ANALYST_MAX_ITERATIONS) ||
        DEFAULT_MAX_ITERATIONS);
  }

  async analyze(
    bundle: EntryBundle,
    ref: ReferenceData,
  ): Promise<AnalystResult> {
    const trace: ToolTraceEntry[] = [];
    const collector: ReportCollector = { report: null };
    const tools = buildAnalystTools({ bundle, ref, trace }, collector);
    // Built once per run and reused by the nudge — byte-identity keeps the
    // cached prefix intact.
    const system = buildSystemPrompt(bundle.orgRules);
    const usage: AnalystUsage = {
      iterations: 0,
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    };
    let error: string | null = null;
    let transcript: unknown[] | null = null;

    try {
      const runner = this.client.beta.messages.toolRunner(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: [
            { role: "user", content: buildInitialUserMessage(bundle) },
          ],
          tools,
          max_iterations: this.maxIterations,
          // Auto-caching: the SDK re-places the breakpoint on the last
          // cacheable block each iteration, so the stable prefix (tools +
          // system + briefing) reads from cache from iteration 2 on.
          cache_control: { type: "ephemeral" },
        },
        { signal: AbortSignal.timeout(this.deadlineMs) },
      );
      for await (const message of runner) {
        usage.iterations += 1;
        const u = message.usage;
        if (u) {
          usage.inputTokens += u.input_tokens ?? 0;
          usage.outputTokens += u.output_tokens ?? 0;
          usage.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
          usage.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
        }
        if (message.stop_reason === "refusal") {
          error = "safety classifiers declined mid-run (stop_reason refusal)";
          break;
        }
      }
      transcript = runner.params.messages;
    } catch (e) {
      // Deadline abort, rate limits, connection errors — analysis is
      // best-effort by contract.
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }

    // The model rambled to end_turn or hit the iteration cap without
    // reporting: one structured-output nudge over the accumulated transcript.
    if (!collector.report && !error && transcript) {
      try {
        const response = await this.client.beta.messages.parse({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: [...transcript, { role: "user", content: NUDGE }],
          // Same tool defs (stripped to wire shape) keep the cached prefix;
          // tool_choice none forces the report out as text.
          tools: tools.map((t) => {
            const wire = t as unknown as {
              type: string;
              name: string;
              description?: string;
              input_schema: unknown;
            };
            return {
              type: wire.type,
              name: wire.name,
              description: wire.description,
              input_schema: wire.input_schema,
            };
          }),
          tool_choice: { type: "none" },
          output_config: { format: betaZodOutputFormat(findingsReportSchema) },
        });
        if (response.stop_reason !== "refusal" && response.parsed_output) {
          collector.report = findingsReportSchema.parse(response.parsed_output);
        } else {
          error = "structured-output fallback declined or returned nothing";
        }
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }

    if (collector.report) {
      return { report: collector.report, usage, trace, analyst: "claude", error };
    }

    // Total failure — surface the deterministic findings at least.
    const fallback = await this.stub.analyze(bundle, ref);
    return {
      report: fallback.report,
      usage,
      trace,
      analyst: "claude",
      error: `degraded to stub findings — ${error ?? "no report emitted"}`,
    };
  }
}
