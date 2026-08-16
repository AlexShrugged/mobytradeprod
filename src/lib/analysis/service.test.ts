import { describe, expect, it } from "vitest";

import { analysisFindingCategory } from "../db/schema";
import { findingCategorySchema, type Finding } from "./findings";
import {
  assignFindingKeys,
  planFindingReconcile,
  type DesiredFinding,
  type ExistingFindingRow,
} from "./service";

const finding = (over: Partial<Finding> = {}): Finding => ({
  category: "fee_error",
  severity: "error",
  title: "MPF below statutory minimum",
  explanation: "Declared MPF is the uncapped ad valorem amount.",
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
  suggestedAction: "File a PSC for the difference.",
  confidence: 0.95,
  relatedAlertKeys: [],
  ...over,
});

const existing = (over: Partial<ExistingFindingRow> = {}): ExistingFindingRow => ({
  id: "f1",
  findingKey: "ai:fee_error:entry",
  status: "open",
  severity: "error",
  title: "MPF below statutory minimum",
  explanation: "Declared MPF is the uncapped ad valorem amount.",
  suggestedAction: "File a PSC for the difference.",
  confidence: "0.950",
  lineItemId: null,
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
  relatedAlertKeys: [],
  ...over,
});

const desired = (key: string, f: Finding, lineItemId: string | null = null): DesiredFinding => ({
  key,
  finding: f,
  lineItemId,
});

describe("category enum parity", () => {
  it("schema column enum matches the analyst's output enum exactly", () => {
    expect([...analysisFindingCategory.enumValues]).toEqual([
      ...findingCategorySchema.options,
    ]);
  });
});

describe("assignFindingKeys", () => {
  it("keys on category and line scope", () => {
    const keys = assignFindingKeys([
      finding(),
      finding({ category: "adcvd_discrepancy", lineNumber: 1 }),
    ]).map((k) => k.key);
    expect(keys).toEqual(["ai:fee_error:entry", "ai:adcvd_discrepancy:1"]);
  });

  it("ordinalizes same-category same-line repeats in report order", () => {
    const keys = assignFindingKeys([
      finding({ lineNumber: 2 }),
      finding({ lineNumber: 2 }),
      finding({ lineNumber: 2 }),
    ]).map((k) => k.key);
    expect(keys).toEqual([
      "ai:fee_error:2",
      "ai:fee_error:2#2",
      "ai:fee_error:2#3",
    ]);
  });
});

describe("planFindingReconcile", () => {
  it("inserts new keys, leaves identical open rows alone", () => {
    const plan = planFindingReconcile(
      [existing()],
      [
        desired("ai:fee_error:entry", finding()),
        desired("ai:adcvd_discrepancy:1", finding({ category: "adcvd_discrepancy", lineNumber: 1 })),
      ],
    );
    expect(plan.toInsert.map((d) => d.key)).toEqual(["ai:adcvd_discrepancy:1"]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toDeleteIds).toEqual([]);
  });

  it("refreshes an open row whose content drifted", () => {
    const plan = planFindingReconcile(
      [existing()],
      [desired("ai:fee_error:entry", finding({ confidence: 0.8 }))],
    );
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0].id).toBe("f1");
  });

  it("ignores jsonb key order when comparing evidence", () => {
    const reordered = {
      statement: "The entry declares MPF of $10.18.",
      quote: "10.18",
      field: "mpfAmount",
      documentId: null,
      source: "entry",
    };
    const plan = planFindingReconcile(
      [existing({ evidence: [reordered] })],
      [desired("ai:fee_error:entry", finding())],
    );
    expect(plan.toUpdate).toEqual([]);
  });

  it("deletes open rows the analyst no longer reports", () => {
    const plan = planFindingReconcile([existing()], []);
    expect(plan.toDeleteIds).toEqual(["f1"]);
  });

  it("never touches resolved or dismissed rows", () => {
    const rows = [
      existing({ id: "r1", status: "resolved" }),
      existing({
        id: "d1",
        status: "dismissed",
        findingKey: "ai:fee_error:entry#2",
      }),
    ];
    // Absent from the report: no delete. Present with new content: no
    // update, no insert — the decided row holds the key.
    const plan = planFindingReconcile(rows, [
      desired("ai:fee_error:entry", finding({ confidence: 0.5 })),
    ]);
    expect(plan.toInsert).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toDeleteIds).toEqual([]);
  });
});
