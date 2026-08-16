// Claude-backed HTS classifier behind the Classifier seam: one structured-
// output call over a deterministically preselected candidate pool. The pool
// keeps the prompt bounded on a real (multi-thousand-row) schedule and pins
// the model to codes that actually exist — candidates outside the pool are
// dropped in validation, so a hallucinated code can never reach the review
// queue. Never throws: any failure falls back to the deterministic stub
// with the error noted in the reasoning, mirroring the extractor precedent.
//
// Relative imports on purpose — reachable from tsx scripts.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { normalizeHts } from "../duty/calculator";
import type { HtsRef, ReferenceData } from "../duty/types";
import { StubClassifier } from "./stub-classifier";
import type {
  CandidateSuggestion,
  Classifier,
  ClassifyInput,
  ClassifyResult,
} from "./types";

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_DEADLINE_MS = 120_000;
const MAX_TOKENS = 4_000;
const POOL_CAP = 120;

const SYSTEM_PROMPT = `You are a customs classification specialist proposing HTS codes for ONE catalog product. You are given the product's facts and a candidate pool of real tariff-schedule rows. Rules:
- Choose ONLY from the candidate pool. If nothing in the pool plausibly covers the product, return outcome "none" with no candidates and say what heading family is missing.
- Argue from the product's objective characteristics and the schedule text under the General Rules of Interpretation. Country of origin is context, never a decider.
- Rank candidates best-first with calibrated confidence (0..1). Outcome "certain" means one candidate clearly wins; "ambiguous" means a human must choose between plausible candidates; a proposal is never a commitment — a human reviews every suggestion.
- Keep reasons short and specific to the schedule text; put the overall argument in reasoning.`;

const outputSchema = z.object({
  outcome: z.enum(["certain", "ambiguous", "none"]),
  reasoning: z.string(),
  candidates: z.array(
    z.object({
      /** Must be a code from the candidate pool, dotted or bare digits. */
      code: z.string(),
      confidence: z.number(),
      reason: z.string(),
    }),
  ),
});

/** The slice of the SDK client this classifier uses — injectable for tests
 *  (same structural-typing idiom as the analyst/extractor). */
export interface ClassifierClient {
  beta: {
    messages: {
      parse(
        params: Record<string, unknown>,
        opts?: { signal?: AbortSignal },
      ): Promise<{
        parsed_output: unknown;
        stop_reason: string | null;
      }>;
    };
  };
}

const isProductCode = (ref: HtsRef): boolean => ref.chapter < 98;

/** Deterministic pool preselection: schedule rows whose description shares
 *  a meaningful term with the product's name/description, plus prefix
 *  neighbors of the current code (6-digit, widened to 4 when empty), capped
 *  and stably ordered. Exported for tests. */
export function buildCandidatePool(
  input: ClassifyInput,
  ref: ReferenceData,
): HtsRef[] {
  const pool = [...ref.htsByDigits.values()].filter(isProductCode);
  const terms = [
    ...new Set(
      `${input.name} ${input.description ?? ""}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3),
    ),
  ];
  const byTerm = pool.filter((h) => {
    const description = h.description.toLowerCase();
    return terms.some((t) => description.includes(t));
  });

  const currentDigits = input.currentHtsCode
    ? normalizeHts(input.currentHtsCode)
    : null;
  let neighbors: HtsRef[] = [];
  if (currentDigits) {
    neighbors = pool.filter((h) =>
      h.codeDigits.startsWith(currentDigits.slice(0, 6)),
    );
    if (neighbors.length === 0) {
      neighbors = pool.filter((h) =>
        h.codeDigits.startsWith(currentDigits.slice(0, 4)),
      );
    }
  }

  const seen = new Set<string>();
  const merged: HtsRef[] = [];
  for (const h of [...byTerm, ...neighbors]) {
    if (seen.has(h.codeDigits)) continue;
    seen.add(h.codeDigits);
    merged.push(h);
  }
  merged.sort((a, b) => a.codeDigits.localeCompare(b.codeDigits));
  return merged.slice(0, POOL_CAP);
}

export class ClaudeClassifier implements Classifier {
  private readonly client: ClassifierClient;
  private readonly stub = new StubClassifier();
  readonly model: string;
  private readonly deadlineMs: number;

  constructor(
    opts: { client?: ClassifierClient; model?: string; deadlineMs?: number } = {},
  ) {
    this.client =
      opts.client ?? (new Anthropic() as unknown as ClassifierClient);
    this.model =
      opts.model ?? process.env.CLASSIFIER_MODEL ?? DEFAULT_MODEL;
    this.deadlineMs =
      opts.deadlineMs ??
      (Number(process.env.CLASSIFIER_DEADLINE_MS) || DEFAULT_DEADLINE_MS);
  }

  async classify(
    input: ClassifyInput,
    ref: ReferenceData,
  ): Promise<ClassifyResult> {
    const pool = buildCandidatePool(input, ref);
    if (pool.length === 0) {
      return {
        outcome: "none",
        candidates: [],
        reasoning:
          "No schedule rows in the reference subset match this product's terms or code neighborhood.",
        classifier: "claude",
      };
    }
    const poolByDigits = new Map(pool.map((h) => [h.codeDigits, h]));

    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                product: {
                  sku: input.sku,
                  name: input.name,
                  description: input.description,
                  countriesOfOrigin: input.countriesOfOrigin,
                  currentHtsCode: input.currentHtsCode,
                },
                candidatePool: pool.map((h) => ({
                  code: h.code,
                  description: h.description,
                })),
              },
              null,
              2,
            ),
          },
        ],
        output_config: { format: betaZodOutputFormat(outputSchema) },
        // Request OPTION, not a body param — inside the params object the
        // SDK serializes it and the API 400s ("signal: Extra inputs are
        // not permitted").
      }, { signal: AbortSignal.timeout(this.deadlineMs) });
      if (response.stop_reason === "refusal" || !response.parsed_output) {
        throw new Error("classifier call declined or returned nothing");
      }
      const parsed = outputSchema.parse(response.parsed_output);

      // Pool-membership validation: an out-of-pool code is dropped, never
      // repaired — repairs would fabricate a suggestion the model did not
      // make.
      const candidates: CandidateSuggestion[] = [];
      for (const c of parsed.candidates) {
        const row = poolByDigits.get(normalizeHts(c.code));
        if (!row) continue;
        candidates.push({
          code: row.code,
          codeDigits: row.codeDigits,
          confidence: Math.min(1, Math.max(0, c.confidence)),
          reason: c.reason,
        });
      }
      const outcome =
        candidates.length === 0 ? "none" : parsed.outcome;
      return {
        outcome,
        candidates,
        reasoning: parsed.reasoning,
        classifier: "claude",
      };
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      const fallback = await this.stub.classify(input, ref);
      return {
        ...fallback,
        reasoning: `Claude classification failed (${note}); deterministic fallback. ${fallback.reasoning}`,
      };
    }
  }
}
