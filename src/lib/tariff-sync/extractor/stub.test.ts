import { describe, expect, it } from "vitest";

import { findSailClauses } from "../sail-clauses";
import type { MeasureExtractionInput } from "./types";
import { StubMeasureExtractor } from "./stub";

// Verbatim-style IEEPA clause the sail-clause highlighter was validated
// against — entry and sail cues both present.
const IEEPA_TEXT =
  "Articles the product of China, except products for personal use, that " +
  "(1) were loaded onto a vessel at the port of loading before 12:01 a.m. " +
  "eastern standard time on February 1, 2025; and (2) are entered for " +
  "consumption, or withdrawn from warehouse for consumption, on or after " +
  "February 4, 2025.";

function inputOf(over: Partial<MeasureExtractionInput> = {}): MeasureExtractionInput {
  const description = over.evidence?.description ?? IEEPA_TEXT;
  return {
    ch99Code: "9903.01.23",
    authority: "ieepa",
    evidence: {
      description,
      general: "The duty provided in the applicable subheading + 10%",
      special: "",
      additionalDuties: "",
      footnotes: "",
      highlights: findSailClauses(description),
      ...over.evidence,
    },
    relatedNotices: [],
    ...over,
  };
}

describe("StubMeasureExtractor", () => {
  const extractor = new StubMeasureExtractor();

  it("is deterministic", async () => {
    const [a] = await extractor.extract([inputOf()]);
    const [b] = await extractor.extract([inputOf()]);
    expect(a).toEqual(b);
  });

  it("parses the additional-duty idiom with high confidence", async () => {
    const [ex] = await extractor.extract([inputOf()]);
    expect(ex.rate).toMatchObject({ value: 0.1, confidence: 0.9 });
    expect(ex.extractor).toBe("stub");
    expect(ex.model).toBeNull();
  });

  it("treats an exemption line as rate 0 at higher confidence", async () => {
    const [ex] = await extractor.extract([
      inputOf({
        evidence: {
          description: "Articles exempt from the additional duties.",
          general: "The duty provided in the applicable subheading",
          special: "",
          additionalDuties: "",
          footnotes: "",
          highlights: [],
        },
      }),
    ]);
    expect(ex.rate).toMatchObject({ value: 0, confidence: 0.95 });
  });

  it("maps sail-clause highlights to date fields below the fill threshold", async () => {
    const [ex] = await extractor.extract([inputOf()]);
    // "loaded onto a vessel ... before February 1, 2025" → sail_before.
    expect(ex.sailedOnOrBefore.value).toBe("2025-02-01");
    expect(ex.sailedOnOrBefore.confidence).toBeLessThan(0.5);
    expect(ex.sailedOnOrBefore.evidence).toContain("exclusive bound");
    // "entered for consumption ... on or after February 4, 2025".
    expect(ex.effectiveDate.value).toBe("2025-02-04");
    expect(ex.effectiveDate.confidence).toBeLessThan(0.5);
  });

  it("detects countries from the product-of phrase", async () => {
    const [ex] = await extractor.extract([inputOf()]);
    expect(ex.countries.value).toEqual(["CN"]);
    expect(ex.countries.evidence).toMatch(/product of China/i);
  });

  it("returns all-null fields for prose that says nothing", async () => {
    const [ex] = await extractor.extract([
      inputOf({
        evidence: {
          description: "Goods of heading 9903.",
          general: "compound rate, see note",
          special: "",
          additionalDuties: "",
          footnotes: "",
          highlights: [],
        },
      }),
    ]);
    expect(ex.rate.value).toBeNull();
    expect(ex.effectiveDate.value).toBeNull();
    expect(ex.countries.value).toBeNull();
  });
});
