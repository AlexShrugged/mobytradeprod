// The savings analyst's tool surface: six betaZodTools closed over a
// preloaded PartBundle + ReferenceData — zero IO inside a tool, mirroring
// the entry analyst. compare_codes is the ONLY sanctioned source of dollar
// figures; report_opportunities is the terminal action.
//
// Relative imports on purpose — this module runs under the tsx script.

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

import {
  computeExpectedCharges,
  normalizeHts,
  resolveBaseSchedule,
  resolveExpectedMeasures,
} from "../../duty/calculator";
import type { ReferenceData } from "../../duty/types";
import type { ToolTraceEntry } from "../types";
import { savingsReportSchema, type SavingsReport } from "./report";
import type { PartBundle } from "./types";

export type SavingsToolContext = {
  bundle: PartBundle;
  ref: ReferenceData;
  trace: ToolTraceEntry[];
};

export type SavingsCollector = { report: SavingsReport | null };

const MAX_RESULT_CHARS = 24_000;
const MAX_SEARCH_RESULTS = 40;
/** Basis when the part has no entry history — comparisons still rank
 *  candidates, they just cannot be annualized. */
const FALLBACK_BASIS_CENTS = 1_000_000;

const todayIso = () => new Date().toISOString().slice(0, 10);

function respond(
  ctx: SavingsToolContext,
  tool: string,
  input: unknown,
  payload: unknown,
): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const capped =
    text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated ${text.length - MAX_RESULT_CHARS} chars — narrow the request]`
      : text;
  ctx.trace.push({ tool, input, resultPreview: capped.slice(0, 300) });
  return capped;
}

/** Case-insensitive all-terms match over a schedule description. */
export function matchesQuery(description: string, query: string): boolean {
  const haystack = description.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function buildSavingsTools(
  ctx: SavingsToolContext,
  collector: SavingsCollector,
): BetaRunnableTool[] {
  const { bundle, ref } = ctx;

  const getPartDetails = betaZodTool({
    name: "get_part_details",
    description:
      "The catalog part under review: name, description, committed HTS classification windows, and per-vendor sourcing facts (COO, unit cost, validity windows).",
    inputSchema: z.object({}),
    run: (input) => respond(ctx, "get_part_details", input, bundle.part),
  });

  const searchSchedule = betaZodTool({
    name: "search_schedule",
    description:
      "Search the tariff schedule (chapters 1-97) for candidate codes by description terms and/or a digit prefix. All terms must match; results are capped, so search specifically. Returns code, description, and base rate.",
    inputSchema: z.object({
      query: z.string().nullable(),
      htsPrefix: z.string().nullable(),
    }),
    run: (input) => {
      if (!input.query && !input.htsPrefix) {
        return respond(
          ctx,
          "search_schedule",
          input,
          "ERROR: give a query, an htsPrefix, or both.",
        );
      }
      const prefix = input.htsPrefix ? normalizeHts(input.htsPrefix) : null;
      const hits: unknown[] = [];
      let total = 0;
      for (const row of ref.htsByDigits.values()) {
        if (row.chapter >= 98) continue;
        if (prefix && !row.codeDigits.startsWith(prefix)) continue;
        if (input.query && !matchesQuery(row.description, input.query)) {
          continue;
        }
        total += 1;
        if (hits.length < MAX_SEARCH_RESULTS) {
          hits.push({
            code: row.code,
            description: row.description,
            rateType: row.rateType,
            rate: row.rate,
          });
        }
      }
      return respond(ctx, "search_schedule", input, {
        matches: hits,
        totalMatches: total,
        truncated: total > hits.length,
      });
    },
  });

  const getMeasures = betaZodTool({
    name: "get_measures",
    description:
      "Resolve which tariff measures (and base-schedule rate) apply to an HTS code + country of origin as of a date. date null = today. Check exclusionDigits: a Chapter 99 exclusion can zero a measure for qualifying goods.",
    inputSchema: z.object({
      hts: z.string(),
      countryOfOrigin: z.string().nullable(),
      date: z.string().nullable(),
    }),
    run: (input) => {
      const date = input.date ?? todayIso();
      const htsDigits = normalizeHts(input.hts);
      const resolved = resolveExpectedMeasures(
        { htsDigits, countryOfOrigin: input.countryOfOrigin, entryDate: date, sail: null },
        ref,
      );
      const base = resolveBaseSchedule(htsDigits, date, ref);
      return respond(ctx, "get_measures", input, {
        htsDigits,
        baseSchedule: base
          ? {
              code: base.code,
              description: base.description,
              rateType: base.rateType,
              rate: base.rate,
            }
          : null,
        applicable: resolved.applicable,
        suppressed: resolved.suppressed,
      });
    },
  });

  const compareCodes = betaZodTool({
    name: "compare_codes",
    description:
      "Price a set of HTS codes against each other: for each code, the full deterministic duty stack (base + Chapter 99 measures with stacking) on the part's trailing 12-month entered value. THE source of truth for savings math — cite its cents, never compute rates yourself. Include the current code in the set so the delta is explicit.",
    inputSchema: z.object({
      codes: z.array(z.string()),
      countryOfOrigin: z.string().nullable(),
      date: z.string().nullable(),
    }),
    run: (input) => {
      if (input.codes.length === 0) {
        return respond(ctx, "compare_codes", input, "ERROR: give at least one code.");
      }
      const date = input.date ?? todayIso();
      const basisCents =
        bundle.trailingEnteredValueCents > 0
          ? bundle.trailingEnteredValueCents
          : FALLBACK_BASIS_CENTS;
      const results = input.codes.map((code) => {
        const htsDigits = normalizeHts(code);
        const expected = computeExpectedCharges(
          {
            htsDigits,
            countryOfOrigin: input.countryOfOrigin,
            enteredValueCents: basisCents,
            entryDate: date,
            sail: null,
          },
          ref,
        );
        const measureCents = expected.measures.reduce(
          (sum, m) => sum + (m.amountCents ?? 0),
          0,
        );
        const nonComputable = expected.measures.filter(
          (m) => m.amountCents === null,
        ).length;
        return {
          code,
          baseDuty: expected.baseDuty,
          measures: expected.measures,
          suppressed: expected.suppressed,
          totalDutyCents:
            expected.baseDuty === null
              ? null
              : (expected.baseDuty.amountCents ?? 0) + measureCents,
          /** Non-ad-valorem measures apply but cannot be priced — a total
           *  alongside these understates the stack. */
          nonComputableMeasures: nonComputable,
        };
      });
      return respond(ctx, "compare_codes", input, {
        basisCents,
        basisIsFallback: bundle.trailingEnteredValueCents === 0,
        asOf: date,
        results,
      });
    },
  });

  const getEntryHistory = betaZodTool({
    name: "get_entry_history",
    description:
      "The part's entry lines from the trailing 12 months, newest first, with declared duty charges — what the org actually paid under the current classification.",
    inputSchema: z.object({}),
    run: (input) =>
      respond(ctx, "get_entry_history", input, {
        trailingEnteredValueCents: bundle.trailingEnteredValueCents,
        lines: bundle.history,
      }),
  });

  const reportOpportunities = betaZodTool({
    name: "report_opportunities",
    description:
      "Submit your final structured savings report. Call this exactly once, as your last action. An empty opportunities list is a legitimate result. Every estimatedAnnualSavingsCents must trace to compare_codes output cited in evidence.",
    inputSchema: savingsReportSchema,
    run: (input) => {
      collector.report = input;
      ctx.trace.push({
        tool: "report_opportunities",
        input: { opportunities: input.opportunities.length },
        resultPreview: "recorded",
      });
      return "Report recorded. End your turn.";
    },
  });

  return [
    getPartDetails,
    searchSchedule,
    getMeasures,
    compareCodes,
    getEntryHistory,
    reportOpportunities,
  ];
}
