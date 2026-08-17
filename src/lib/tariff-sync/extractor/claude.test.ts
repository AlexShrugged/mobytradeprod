import { describe, expect, it, vi } from "vitest";

import { ClaudeMeasureExtractor, type ParseClient } from "./claude";
import type { MeasureExtractionInput } from "./types";

const input = (ch99Code: string): MeasureExtractionInput => ({
  ch99Code,
  authority: "section_301",
  evidence: {
    description: `Articles the product of China under ${ch99Code}.`,
    general: "The duty provided in the applicable subheading + 25%",
    special: "",
    additionalDuties: "",
    footnotes: "",
    highlights: [],
  },
  relatedNotices: [
    {
      documentNumber: "2026-01234",
      title: "Notice of Modification of Section 301 Action",
      htmlUrl: "https://example.test",
      publicationDate: "2026-07-01",
      abstract: "Effective August 1, 2026 …",
      agencies: ["Office of the United States Trade Representative"],
      rawTextUrl: null,
    },
  ],
});

const parsedFor = (ch99Code: string, over: Record<string, unknown> = {}) => ({
  ch99Code,
  effectiveDate: { value: "2026-08-01", confidence: 0.9, evidence: "Effective August 1, 2026" },
  endDate: { value: null, confidence: 0, evidence: null },
  sailedOnOrAfter: { value: null, confidence: 0, evidence: null },
  sailedOnOrBefore: { value: null, confidence: 0, evidence: null },
  countries: { value: ["CN"], confidence: 1, evidence: "product of China" },
  rate: { value: 0.25, confidence: 1, evidence: "+ 25%" },
  notes: null,
  ...over,
});

function clientReturning(
  fn: (params: { messages: { content: string }[] }) => {
    parsed_output: unknown;
    stop_reason: string | null;
  },
): ParseClient {
  return {
    messages: {
      parse: vi.fn(async (params: never) => fn(params as never)) as never,
    },
  } as unknown as ParseClient;
}

describe("ClaudeMeasureExtractor", () => {
  it("sends the prose and notices, and maps parsed output by ch99Code", async () => {
    let sentContent = "";
    const client = clientReturning((params) => {
      sentContent = params.messages[0].content;
      return {
        parsed_output: { extractions: [parsedFor("9903.88.01")] },
        stop_reason: "end_turn",
      };
    });
    const extractor = new ClaudeMeasureExtractor({ client, model: "claude-opus-5" });

    const [ex] = await extractor.extract([input("9903.88.01")]);

    const sent = JSON.parse(sentContent);
    expect(sent.lines[0].ch99Code).toBe("9903.88.01");
    expect(sent.relatedFederalRegisterNotices[0].documentNumber).toBe("2026-01234");

    expect(ex.extractor).toBe("claude");
    expect(ex.model).toBe("claude-opus-5");
    expect(ex.effectiveDate.value).toBe("2026-08-01");
    expect(ex.countries.value).toEqual(["CN"]);
  });

  it("nulls malformed dates instead of passing them downstream", async () => {
    const client = clientReturning(() => ({
      parsed_output: {
        extractions: [
          parsedFor("9903.88.01", {
            effectiveDate: { value: "August 1, 2026", confidence: 0.9, evidence: "…" },
          }),
        ],
      },
      stop_reason: "end_turn",
    }));
    const extractor = new ClaudeMeasureExtractor({ client });

    const [ex] = await extractor.extract([input("9903.88.01")]);
    expect(ex.effectiveDate.value).toBeNull();
    expect(ex.effectiveDate.confidence).toBe(0);
  });

  it("falls back to the stub for lines the model skipped", async () => {
    const client = clientReturning(() => ({
      parsed_output: { extractions: [parsedFor("9903.88.01")] },
      stop_reason: "end_turn",
    }));
    const extractor = new ClaudeMeasureExtractor({ client });

    const results = await extractor.extract([
      input("9903.88.01"),
      input("9903.88.02"), // absent from the model's output
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].extractor).toBe("claude");
    expect(results[1].extractor).toBe("stub");
    // The stub still parsed the deterministic rate.
    expect(results[1].rate.value).toBe(0.25);
  });

  it("degrades the whole chunk to the stub on API errors", async () => {
    const client: ParseClient = {
      messages: {
        parse: vi.fn(async () => {
          throw new Error("rate limited");
        }) as never,
      },
    };
    const extractor = new ClaudeMeasureExtractor({ client });

    const results = await extractor.extract([input("9903.88.01")]);
    expect(results).toHaveLength(1);
    expect(results[0].extractor).toBe("stub");
  });

  it("degrades to the stub on a refusal stop reason", async () => {
    const client = clientReturning(() => ({
      parsed_output: null,
      stop_reason: "refusal",
    }));
    const extractor = new ClaudeMeasureExtractor({ client });

    const [ex] = await extractor.extract([input("9903.88.01")]);
    expect(ex.extractor).toBe("stub");
  });

  it("stops calling the API once the deadline is exhausted", async () => {
    const parse = vi.fn(async () => ({
      parsed_output: { extractions: [] },
      stop_reason: "end_turn" as const,
    }));
    const client = { messages: { parse } } as unknown as ParseClient;
    const extractor = new ClaudeMeasureExtractor({ client, deadlineMs: -1 });

    // 20 inputs → 2 chunks; both past the (already-expired) deadline.
    const inputs = Array.from({ length: 20 }, (_, i) =>
      input(`9903.88.${String(i).padStart(2, "0")}`),
    );
    const results = await extractor.extract(inputs);
    expect(results).toHaveLength(20);
    expect(parse).not.toHaveBeenCalled();
    expect(results.every((r) => r.extractor === "stub")).toBe(true);
  });
});
