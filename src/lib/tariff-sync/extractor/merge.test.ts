import { describe, expect, it } from "vitest";

import type { ProposedRevision } from "../types";
import { FILL_CONFIDENCE, mergeExtraction } from "./merge";
import type { ExtractedField, MeasureExtraction } from "./types";

const field = <T,>(
  value: T | null,
  confidence = 0,
  evidence: string | null = null,
): ExtractedField<T> => ({ value, confidence, evidence });

const emptyExtraction = (over: Partial<MeasureExtraction> = {}): MeasureExtraction => ({
  ch99Code: "9903.88.01",
  effectiveDate: field<string>(null),
  endDate: field<string>(null),
  sailedOnOrAfter: field<string>(null),
  sailedOnOrBefore: field<string>(null),
  countries: field<string[]>(null),
  rate: field<number>(null),
  notes: null,
  extractor: "claude",
  model: "claude-opus-5",
  ...over,
});

const revision = (over: Partial<ProposedRevision["proposed"]> = {}): ProposedRevision => ({
  changeType: "create_measure",
  ch99Code: "9903.88.01",
  authority: "section_301",
  targetMeasureId: null,
  proposed: {
    name: "Section 301 — 9903.88.01",
    authority: "section_301",
    scope: "all_products",
    countries: null,
    effectiveDate: null,
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    rate: 0.25,
    exemption: false,
    inLieuOfBaseDuty: false,
    prefixes: [],
    notes: null,
    ...over,
  },
  evidence: {
    description: "…",
    general: "The duty provided in the applicable subheading + 25%",
    special: "",
    additionalDuties: "",
    footnotes: "",
    highlights: [],
  },
  liveSnapshot: null,
  contentHash: "abc123",
});

describe("mergeExtraction", () => {
  it("fills null dates at or above the confidence floor", () => {
    const merged = mergeExtraction(
      revision(),
      emptyExtraction({
        effectiveDate: field("2025-02-04", FILL_CONFIDENCE, "on or after February 4, 2025"),
      }),
    );
    expect(merged.proposed.effectiveDate).toBe("2025-02-04");
  });

  it("leaves sub-threshold values as evidence only", () => {
    const merged = mergeExtraction(
      revision(),
      emptyExtraction({
        effectiveDate: field("2025-02-04", 0.4, "…"),
      }),
    );
    expect(merged.proposed.effectiveDate).toBeNull();
    // …but the extraction still rides along for the review card.
    expect(merged.evidence.extraction?.effectiveDate.value).toBe("2025-02-04");
  });

  it("never overwrites the differ's deterministic values", () => {
    const merged = mergeExtraction(
      revision({ rate: 0.25, countries: ["CN"] }),
      emptyExtraction({
        rate: field(0.99, 1),
        countries: field(["JP"], 1),
      }),
    );
    expect(merged.proposed.rate).toBe(0.25);
    expect(merged.proposed.countries).toEqual(["CN"]);
  });

  it("fills a null rate and countries at high confidence", () => {
    const merged = mergeExtraction(
      revision({ rate: null, countries: null }),
      emptyExtraction({
        rate: field(0.075, 0.8, "+ 7.5%"),
        countries: field(["CN", "HK"], 0.9),
      }),
    );
    expect(merged.proposed.rate).toBe(0.075);
    expect(merged.proposed.countries).toEqual(["CN", "HK"]);
  });

  it("never fills a numeric rate onto a non-ad-valorem measure", () => {
    const merged = mergeExtraction(
      revision({ rate: null, rateType: "specific", rateText: "$80/net ton" }),
      emptyExtraction({ rate: field(0.25, 1, "+ 25%") }),
    );
    // Presence-only stays presence-only — the raw text is the truth.
    expect(merged.proposed.rate).toBeNull();
    expect(merged.proposed.rateText).toBe("$80/net ton");
  });

  it("keeps contentHash untouched — merge must not break re-run dedupe", () => {
    const rev = revision();
    const merged = mergeExtraction(
      rev,
      emptyExtraction({ effectiveDate: field("2025-02-04", 1) }),
    );
    expect(merged.contentHash).toBe(rev.contentHash);
  });
});
