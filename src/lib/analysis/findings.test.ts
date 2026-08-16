import { describe, expect, it } from "vitest";

import {
  findingCategorySchema,
  findingSchema,
  findingsReportSchema,
} from "./findings";

const validFinding = {
  category: "fee_error",
  severity: "warning",
  title: "MPF below statutory minimum",
  explanation: "Declared MPF of $10.18 is below the FY minimum.",
  lineNumber: null,
  fields: [{ field: "MPF", filed: "$10.18", expected: "$33.58" }],
  evidence: [
    {
      source: "entry",
      documentId: null,
      field: "mpfAmount",
      quote: "10.18",
      statement: "The entry declares MPF of $10.18.",
    },
  ],
  suggestedAction: "Confirm the broker applied the per-entry minimum.",
  confidence: 0.9,
  relatedAlertKeys: [],
};

describe("findingsReportSchema", () => {
  it("accepts a well-formed report", () => {
    const parsed = findingsReportSchema.parse({
      summary: "One fee issue found.",
      findings: [validFinding],
    });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].category).toBe("fee_error");
  });

  it("accepts an empty findings list", () => {
    const parsed = findingsReportSchema.parse({
      summary: "Nothing found.",
      findings: [],
    });
    expect(parsed.findings).toEqual([]);
  });

  it("rejects an unknown category", () => {
    expect(() =>
      findingSchema.parse({ ...validFinding, category: "vibes" }),
    ).toThrow();
  });

  it("rejects a missing evidence quote", () => {
    expect(() =>
      findingSchema.parse({
        ...validFinding,
        evidence: [
          { source: "entry", documentId: null, field: null, statement: "x" },
        ],
      }),
    ).toThrow();
  });

  it("rejects evidence without a human statement", () => {
    expect(() =>
      findingSchema.parse({
        ...validFinding,
        evidence: [
          { source: "entry", documentId: null, field: null, quote: "10.18" },
        ],
      }),
    ).toThrow();
  });

  it("accepts a pure observation with no field diff", () => {
    const parsed = findingSchema.parse({ ...validFinding, fields: [] });
    expect(parsed.fields).toEqual([]);
  });

  it("keeps 'other' as the escape-hatch category", () => {
    expect(findingCategorySchema.options).toContain("other");
  });
});
