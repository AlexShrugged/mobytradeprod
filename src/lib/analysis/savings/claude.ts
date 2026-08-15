// Claude-backed savings analyst: the SDK tool runner drives an
// investigation loop over the six savings tools; report_opportunities is
// the terminal action. Same resilience contract as the entry analyst — a
// run that ends without a report gets ONE structured-output nudge; total
// failure returns an empty report with the error noted. Never throws.
//
// Relative imports on purpose — this module runs under the tsx script.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

import type { ReferenceData } from "../../duty/types";
import type { AnalystClient } from "../claude";
import type { AnalystUsage, ToolTraceEntry } from "../types";
import { savingsReportSchema } from "./report";
import { buildSavingsUserMessage, SAVINGS_SYSTEM_PROMPT } from "./prompt";
import { buildSavingsTools, type SavingsCollector } from "./tools";
import type { PartBundle, SavingsAnalyst, SavingsResult } from "./types";

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_DEADLINE_MS = 600_000;
const DEFAULT_MAX_ITERATIONS = 12;
const MAX_TOKENS = 16_000;

const NUDGE =
  "Your review is over. Emit your final savings report now as structured output — opportunities you can no longer support with evidence should be dropped, not padded.";

const EMPTY_USAGE = (): AnalystUsage => ({
  iterations: 0,
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
});

export class ClaudeSavingsAnalyst implements SavingsAnalyst {
  private readonly client: AnalystClient;
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
      opts.model ??
      process.env.SAVINGS_ANALYST_MODEL ??
      process.env.ENTRY_ANALYST_MODEL ??
      DEFAULT_MODEL;
    this.deadlineMs =
      opts.deadlineMs ??
      (Number(process.env.ENTRY_ANALYST_DEADLINE_MS) || DEFAULT_DEADLINE_MS);
    this.maxIterations =
      opts.maxIterations ??
      (Number(process.env.ENTRY_ANALYST_MAX_ITERATIONS) ||
        DEFAULT_MAX_ITERATIONS);
  }

  async analyze(
    bundle: PartBundle,
    ref: ReferenceData,
  ): Promise<SavingsResult> {
    const trace: ToolTraceEntry[] = [];
    const collector: SavingsCollector = { report: null };
    const tools = buildSavingsTools({ bundle, ref, trace }, collector);
    const usage = EMPTY_USAGE();
    let error: string | null = null;
    let transcript: unknown[] | null = null;

    try {
      const runner = this.client.beta.messages.toolRunner(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SAVINGS_SYSTEM_PROMPT,
          messages: [
            { role: "user", content: buildSavingsUserMessage(bundle) },
          ],
          tools,
          max_iterations: this.maxIterations,
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
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }

    if (!collector.report && !error && transcript) {
      try {
        const response = await this.client.beta.messages.parse({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SAVINGS_SYSTEM_PROMPT,
          messages: [...transcript, { role: "user", content: NUDGE }],
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
          output_config: { format: betaZodOutputFormat(savingsReportSchema) },
        });
        if (response.stop_reason !== "refusal" && response.parsed_output) {
          collector.report = savingsReportSchema.parse(response.parsed_output);
        } else {
          error = "structured-output fallback declined or returned nothing";
        }
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }

    return {
      report: collector.report ?? {
        summary: "No report produced.",
        opportunities: [],
      },
      usage,
      trace,
      analyst: "claude",
      error: collector.report ? error : (error ?? "no report emitted"),
    };
  }
}
