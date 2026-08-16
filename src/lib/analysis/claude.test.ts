import { describe, expect, it } from "vitest";

import { ClaudeEntryAnalyst, type AnalystClient } from "./claude";
import type { FindingsReport } from "./findings";
import { fixtureBundle, fixtureRef as ref } from "./test-fixtures";

type RunnableLike = {
  name: string;
  run: (input: unknown) => unknown | Promise<unknown>;
};

const aiReport: FindingsReport = {
  summary: "One AI finding.",
  findings: [
    {
      category: "fee_error",
      severity: "warning",
      title: "MPF below minimum",
      explanation: "Declared MPF is below the statutory minimum.",
      lineNumber: null,
      fields: [{ field: "MPF", filed: "$34.64", expected: "$33.58" }],
      evidence: [
        {
          source: "entry",
          documentId: null,
          field: "mpfAmount",
          quote: "34.64",
          statement: "The entry declares MPF of $34.64.",
        },
      ],
      suggestedAction: "Verify with the broker.",
      confidence: 0.8,
      relatedAlertKeys: [],
    },
  ],
};

/** A scripted runner: drive() runs per iteration with the tools the analyst
 *  passed in, so the real tool objects (and the collector behind them) are
 *  exercised end to end. */
function fakeClient(opts: {
  drive?: (iteration: number, tools: RunnableLike[]) => Promise<unknown>;
  iterations?: { stop_reason: string | null; usage?: Record<string, number> }[];
  throwAfter?: number;
  parse?: (params: Record<string, unknown>) => Promise<{
    parsed_output: unknown;
    stop_reason: string | null;
  }>;
}): AnalystClient & { parseCalls: Record<string, unknown>[] } {
  const parseCalls: Record<string, unknown>[] = [];
  return {
    parseCalls,
    beta: {
      messages: {
        toolRunner(params: Record<string, unknown>) {
          const tools = params.tools as unknown as RunnableLike[];
          const messages = params.messages as unknown[];
          const iterations = opts.iterations ?? [
            { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 40 } },
          ];
          return {
            params: { messages },
            async *[Symbol.asyncIterator]() {
              for (let i = 0; i < iterations.length; i++) {
                if (opts.throwAfter !== undefined && i >= opts.throwAfter) {
                  throw new Error("TimeoutError: operation aborted");
                }
                await opts.drive?.(i, tools);
                messages.push({ role: "assistant", content: `turn ${i}` });
                yield iterations[i] as never;
              }
            },
          };
        },
        parse: async (params: Record<string, unknown>) => {
          parseCalls.push(params);
          if (!opts.parse) throw new Error("parse not expected");
          return opts.parse(params);
        },
      },
    },
  };
}

describe("ClaudeEntryAnalyst", () => {
  it("returns the report the model filed via report_findings", async () => {
    const client = fakeClient({
      drive: async (i, tools) => {
        if (i === 1) {
          const report = tools.find((t) => t.name === "report_findings")!;
          await report.run(aiReport);
        }
      },
      iterations: [
        { stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 90 } },
        { stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 90 } },
      ],
    });
    const result = await new ClaudeEntryAnalyst({ client }).analyze(
      fixtureBundle(),
      ref,
    );
    expect(result.error).toBeNull();
    expect(result.analyst).toBe("claude");
    expect(result.report.summary).toBe("One AI finding.");
    expect(result.usage).toEqual({
      iterations: 2,
      inputTokens: 120,
      outputTokens: 50,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 90,
    });
    expect(client.parseCalls).toHaveLength(0);
  });

  it("falls back to one structured-output nudge when no report was filed", async () => {
    const client = fakeClient({
      parse: async () => ({ parsed_output: aiReport, stop_reason: "end_turn" }),
    });
    const result = await new ClaudeEntryAnalyst({ client }).analyze(
      fixtureBundle(),
      ref,
    );
    expect(result.error).toBeNull();
    expect(result.report.summary).toBe("One AI finding.");
    expect(client.parseCalls).toHaveLength(1);
    const call = client.parseCalls[0];
    expect(call.tool_choice).toEqual({ type: "none" });
    // The nudge rides on the accumulated transcript, not a fresh context.
    expect((call.messages as unknown[]).length).toBeGreaterThan(1);
  });

  it("degrades to deterministic stub findings on refusal", async () => {
    const client = fakeClient({
      iterations: [{ stop_reason: "refusal" }],
    });
    const result = await new ClaudeEntryAnalyst({ client }).analyze(
      fixtureBundle(),
      ref,
    );
    expect(result.error).toContain("refusal");
    expect(result.error).toContain("degraded to stub findings");
    expect(result.report.findings.length).toBeGreaterThan(0);
    expect(result.report.findings[0].relatedAlertKeys.length).toBe(1);
    expect(client.parseCalls).toHaveLength(0);
  });

  it("never throws — a mid-run crash degrades with the error noted", async () => {
    const client = fakeClient({ throwAfter: 1, iterations: [
      { stop_reason: "tool_use", usage: { input_tokens: 50, output_tokens: 5 } },
      { stop_reason: "end_turn" },
    ] });
    const result = await new ClaudeEntryAnalyst({ client }).analyze(
      fixtureBundle(),
      ref,
    );
    expect(result.error).toContain("degraded to stub findings");
    expect(result.usage.iterations).toBe(1);
  });

  it("keeps a report filed before a crash, with the error noted", async () => {
    const client = fakeClient({
      drive: async (i, tools) => {
        if (i === 0) {
          await tools.find((t) => t.name === "report_findings")!.run(aiReport);
        }
      },
      throwAfter: 1,
      iterations: [
        { stop_reason: "tool_use", usage: { input_tokens: 50, output_tokens: 5 } },
        { stop_reason: "end_turn" },
      ],
    });
    const result = await new ClaudeEntryAnalyst({ client }).analyze(
      fixtureBundle(),
      ref,
    );
    expect(result.report.summary).toBe("One AI finding.");
    expect(result.error).toContain("TimeoutError");
  });

  it("degrades when the parse fallback also fails", async () => {
    const client = fakeClient({
      parse: async () => ({ parsed_output: null, stop_reason: "refusal" }),
    });
    const result = await new ClaudeEntryAnalyst({ client }).analyze(
      fixtureBundle(),
      ref,
    );
    expect(result.error).toContain("degraded to stub findings");
    expect(result.report.findings.length).toBeGreaterThan(0);
  });
});
