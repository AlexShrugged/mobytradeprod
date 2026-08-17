// Claude-backed measure extraction: proposes dates/countries/rates for
// staged Chapter 99 revisions from the line's own prose plus related
// Federal Register abstracts, with per-field confidence and verbatim
// evidence. Output lands ONLY in staging (measure_revisions) — the merge
// step enforces that deterministic values win and sub-threshold fields stay
// evidence-only, and apply.ts still writes exactly what the reviewer
// confirmed. Any chunk failure or deadline exhaustion degrades to the
// deterministic stub: a sync must never fail because of extraction.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { clipNoticeForCodes } from "./notice-clip";
import { StubMeasureExtractor } from "./stub";
import type {
  ExtractedField,
  MeasureExtraction,
  MeasureExtractionInput,
  MeasureExtractor,
} from "./types";

const DEFAULT_MODEL = "claude-opus-5";
const CHUNK_SIZE = 15;
// Env-tunable for large backfills (a full-queue re-stage runs 40+ chunks);
// the default stays conservative for the daily cron's incremental staging.
const CONCURRENCY = Math.max(1, Number(process.env.EXTRACTOR_CONCURRENCY) || 2);
const DEFAULT_DEADLINE_MS = 120_000;
/** Notices with a body excerpt matching the chunk's codes, per prompt. */
const MAX_EXCERPTED_NOTICES = 10;
/** Abstract-only notices per prompt — targeted retrieval can grow the
 *  corpus well past what every chunk should carry. */
const MAX_UNEXCERPTED_NOTICES = 30;

const fieldSchema = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.nullable(),
    confidence: z.number(),
    evidence: z.string().nullable(),
  });

const extractionSchema = z.object({
  extractions: z.array(
    z.object({
      ch99Code: z.string(),
      effectiveDate: fieldSchema(z.string()),
      endDate: fieldSchema(z.string()),
      sailedOnOrAfter: fieldSchema(z.string()),
      sailedOnOrBefore: fieldSchema(z.string()),
      countries: fieldSchema(z.array(z.string())),
      rate: fieldSchema(z.number()),
      notes: z.string().nullable(),
    }),
  ),
});

const SYSTEM_PROMPT = `You extract structured facts about US Chapter 99 tariff measures (Section 301/232, IEEPA, reciprocal, etc.) from HTS line prose and Federal Register notices.

For each Chapter 99 line, fill:
- effectiveDate: the ENTRY-date window start (ISO YYYY-MM-DD) — "entered for consumption on or after D".
- endDate: the last day the entry window is open, INCLUSIVE. "entered before D" means the window ends D minus one day — report the inclusive end date.
- sailedOnOrAfter / sailedOnOrBefore: sail/lading-date conditions ("loaded onto a vessel", "laden aboard"), INCLUSIVE bounds. "before D" on a sail clause means sailedOnOrBefore is D minus one day.
- countries: ISO 3166-1 alpha-2 codes the measure applies to ("products of China and Hong Kong" -> ["CN","HK"]). null when the text names no countries (measure applies to all).
- rate: the additional ad-valorem duty as a DECIMAL FRACTION (25% -> 0.25). 0 for exemption/no-surcharge lines. null when the rate is specific/compound or the text doesn't say.
- notes: one short sentence of context a human reviewer would want (e.g. the legal authority or savings-clause structure), or null.

Rules:
- Every non-null value MUST be backed by a VERBATIM evidence snippet copied from the provided text. No snippet, no value.
- A notice's relevantExcerpt is verbatim body text around mentions of the input codes — the operative "entered for consumption on or after ..." language usually lives there. Prefer it over the abstract, and match each line to the excerpt language that covers its code (an excerpt may cover some of the input lines and not others).
- confidence is 0..1: 1.0 = the text states it outright; below 0.5 = you are inferring. When the text does not say, use value null, confidence 0, evidence null.
- Dates must come from the provided text (line prose or a related notice) — never from world knowledge.
- Return one extraction object per input line, keyed by its ch99Code, in the same order as the input.`;

type ParsedChunk = z.infer<typeof extractionSchema>;

/** The slice of the SDK client this extractor uses — injectable for tests. */
export interface ParseClient {
  messages: {
    parse(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
      output_config: { format: unknown };
    }): Promise<{
      parsed_output: ParsedChunk | null;
      stop_reason: string | null;
    }>;
  };
}

export class ClaudeMeasureExtractor implements MeasureExtractor {
  private readonly client: ParseClient;
  private readonly stub = new StubMeasureExtractor();
  readonly model: string;
  private readonly deadlineMs: number;

  constructor(opts: { client?: ParseClient; model?: string; deadlineMs?: number } = {}) {
    // The structural ParseClient narrows the SDK surface to what we call —
    // the real client satisfies it at runtime; the cast bridges the SDK's
    // generic parse() signature.
    // Backfill re-stages run 40+ concurrent-ish chunks; lean on the SDK's
    // 429/529 backoff instead of degrading a rate-limited chunk to the stub.
    this.client =
      opts.client ??
      (new Anthropic({ maxRetries: 5 }) as unknown as ParseClient);
    this.model =
      opts.model ?? process.env.TARIFF_EXTRACTOR_MODEL ?? DEFAULT_MODEL;
    this.deadlineMs =
      opts.deadlineMs ??
      (Number(process.env.EXTRACTOR_DEADLINE_MS) || DEFAULT_DEADLINE_MS);
  }

  async extract(
    inputs: MeasureExtractionInput[],
  ): Promise<MeasureExtraction[]> {
    const deadline = Date.now() + this.deadlineMs;
    const chunks: MeasureExtractionInput[][] = [];
    for (let i = 0; i < inputs.length; i += CHUNK_SIZE) {
      chunks.push(inputs.slice(i, i + CHUNK_SIZE));
    }

    const results = new Array<MeasureExtraction[]>(chunks.length);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const index = next++;
        const chunk = chunks[index];
        if (Date.now() > deadline) {
          // Out of time — the rest of the sync must not wait on us.
          results[index] = this.stub.extractChunk(chunk);
          continue;
        }
        results[index] = await this.extractChunk(chunk);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker),
    );
    return results.flat();
  }

  private async extractChunk(
    chunk: MeasureExtractionInput[],
  ): Promise<MeasureExtraction[]> {
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(chunk) }],
        output_config: { format: zodOutputFormat(extractionSchema) },
      });
      // Safety classifiers can decline (stop_reason "refusal") and parsing
      // can fail — both degrade to the stub, never to a thrown error.
      if (response.stop_reason === "refusal" || !response.parsed_output) {
        return this.stub.extractChunk(chunk);
      }
      return reconcileChunk(chunk, response.parsed_output, this.model, (input) =>
        this.stub.extractOne(input),
      );
    } catch (err) {
      // RateLimitError, APIConnectionError, schema mismatch, anything —
      // extraction is best-effort by contract. Loudly best-effort: a whole
      // sync silently staging stub-quality proposals is undebuggable.
      console.error(
        `[extractor] chunk of ${chunk.length} degraded to stub:`,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
      return this.stub.extractChunk(chunk);
    }
  }
}

function buildUserContent(chunk: MeasureExtractionInput[]): string {
  const lines = chunk.map((input) => ({
    ch99Code: input.ch99Code,
    authority: input.authority,
    description: input.evidence.description,
    generalRateText: input.evidence.general,
    specialRateText: input.evidence.special,
    additionalDuties: input.evidence.additionalDuties,
    footnotes: input.evidence.footnotes,
  }));
  const codes = chunk.map((input) => input.ch99Code);
  // Two ranked passes so the excerpt budget goes to the best evidence: a
  // notice that PRINTS one of the chunk's codes beats a prefix-only match
  // (reciprocal-tariff annexes list hundreds of headings and would
  // otherwise crowd out the founding documents with junk windows).
  const deduped = dedupeNotices(chunk);
  const excerptByDocument = new Map<string, string>();
  for (const exactOnly of [true, false]) {
    for (const n of deduped) {
      if (excerptByDocument.size >= MAX_EXCERPTED_NOTICES) break;
      if (!n.fullText || excerptByDocument.has(n.documentNumber)) continue;
      const excerpt = clipNoticeForCodes(n.fullText, codes, { exactOnly });
      if (excerpt) excerptByDocument.set(n.documentNumber, excerpt);
    }
  }
  const mapped = deduped.map((n) => ({
    documentNumber: n.documentNumber,
    title: n.title,
    publicationDate: n.publicationDate,
    abstract: n.abstract,
    // Verbatim body text around this chunk's codes — where the operative
    // entry-date language lives; null when the notice never mentions them.
    relevantExcerpt: excerptByDocument.get(n.documentNumber) ?? null,
  }));
  const notices = [
    ...mapped.filter((n) => n.relevantExcerpt !== null),
    ...mapped
      .filter((n) => n.relevantExcerpt === null)
      .sort((a, b) => b.publicationDate.localeCompare(a.publicationDate))
      .slice(0, MAX_UNEXCERPTED_NOTICES),
  ];
  return JSON.stringify({ lines, relatedFederalRegisterNotices: notices });
}

function dedupeNotices(chunk: MeasureExtractionInput[]) {
  const seen = new Map<string, MeasureExtractionInput["relatedNotices"][number]>();
  for (const input of chunk) {
    for (const n of input.relatedNotices) seen.set(n.documentNumber, n);
  }
  return [...seen.values()];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateField(f: ExtractedField<string>): ExtractedField<string> {
  // A malformed date is worse than none — the review card renders it into
  // a date input and apply validates windows against it.
  if (f.value !== null && !ISO_DATE.test(f.value)) {
    return { value: null, confidence: 0, evidence: f.evidence };
  }
  return f;
}

/** Map the model's output back onto the input chunk by ch99Code; any line
 *  the model skipped or mangled falls back to the stub. */
function reconcileChunk(
  chunk: MeasureExtractionInput[],
  parsed: ParsedChunk,
  model: string,
  stubOne: (input: MeasureExtractionInput) => MeasureExtraction,
): MeasureExtraction[] {
  const byCode = new Map(parsed.extractions.map((e) => [e.ch99Code, e]));
  return chunk.map((input) => {
    const e = byCode.get(input.ch99Code);
    if (!e) return stubOne(input);
    return {
      ch99Code: input.ch99Code,
      effectiveDate: dateField(e.effectiveDate),
      endDate: dateField(e.endDate),
      sailedOnOrAfter: dateField(e.sailedOnOrAfter),
      sailedOnOrBefore: dateField(e.sailedOnOrBefore),
      countries: e.countries,
      rate: e.rate,
      notes: e.notes,
      extractor: "claude",
      model,
    };
  });
}
