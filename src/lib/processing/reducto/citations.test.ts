import { describe, expect, it } from "vitest";

import type {
  ExtractionCitations,
  PortEntryExtraction,
} from "../types";
import {
  leafCitation,
  pageResolver,
  pruneCitations,
  recordCitations,
} from "./citations";

const bbox = (page: number, original_page?: number) => ({
  left: 0.1,
  top: 0.2,
  width: 0.3,
  height: 0.02,
  page,
  ...(original_page === undefined ? {} : { original_page }),
});

describe("pageResolver", () => {
  it("takes original_page when the provider names it", () => {
    expect(pageResolver([4, 5, 6])({ page: 2, original_page: 5 })).toBe(5);
    expect(pageResolver(null)({ page: 2, original_page: 2 })).toBe(2);
  });

  it("maps a range-relative page through a packet child's page range", () => {
    expect(pageResolver([4, 5, 6])({ page: 2 })).toBe(5);
    expect(pageResolver([4, 5, 6])({ page: 9 })).toBe(9);
  });

  it("reads an original_page equal to the relative page as relative (payloads before 2026-09-11)", () => {
    expect(pageResolver([5])({ page: 1, original_page: 1 })).toBe(5);
    expect(pageResolver([2, 3])({ page: 2, original_page: 2 })).toBe(3);
    expect(
      pageResolver([5, 6, 7, 8, 11, 12])({ page: 5, original_page: 5 }),
    ).toBe(11);
    // A range starting at 1 reads the same either way.
    expect(pageResolver([1, 2])({ page: 2, original_page: 2 })).toBe(2);
    // Past the range: the original is the only page we have.
    expect(pageResolver([5])({ page: 3, original_page: 3 })).toBe(3);
  });

  it("keeps a standalone document's page as is", () => {
    expect(pageResolver(null)({ page: 3 })).toBe(3);
    expect(pageResolver([])({ page: 3 })).toBe(3);
  });
});

describe("leafCitation", () => {
  const pageOf = pageResolver(null);

  it("reads every box and the printed text of a cited leaf", () => {
    const leaf = {
      value: 12.5,
      citations: [
        { type: "Table", content: "12.50", bbox: bbox(1) },
        { type: "Text", content: "Total 12.50", bbox: bbox(2) },
      ],
    };
    expect(leafCitation(leaf, pageOf)).toEqual({
      boxes: [
        { page: 1, left: 0.1, top: 0.2, width: 0.3, height: 0.02 },
        { page: 2, left: 0.1, top: 0.2, width: 0.3, height: 0.02 },
      ],
      printed: "12.50 Total 12.50",
    });
  });

  it("is null for an inferred value, a box-less citation, or a plain value", () => {
    expect(leafCitation({ value: 1, citations: [] }, pageOf)).toBeNull();
    expect(
      leafCitation({ value: 1, citations: [{ content: "1" }] }, pageOf),
    ).toBeNull();
    expect(
      leafCitation(
        { value: 1, citations: [{ bbox: { left: 0.1, top: 0.1 } }] },
        pageOf,
      ),
    ).toBeNull();
    expect(leafCitation(1, pageOf)).toBeNull();
    expect(leafCitation({ value: 1 }, pageOf)).toBeNull();
  });

  it("caps the printed text a whole-table citation carries", () => {
    const leaf = {
      value: 1,
      citations: [{ content: "x".repeat(2000), bbox: bbox(1) }],
    };
    expect(leafCitation(leaf, pageOf)?.printed).toHaveLength(400);
  });
});

describe("recordCitations", () => {
  it("keeps only the named fields that are cited", () => {
    const record = {
      amount: { value: 5, citations: [{ content: "5", bbox: bbox(1) }] },
      rate: { value: 0.1, citations: [] },
      note: { value: "x", citations: [{ content: "x", bbox: bbox(1) }] },
    };
    const out = recordCitations(record, ["amount", "rate"], pageResolver(null));
    expect(Object.keys(out)).toEqual(["amount"]);
    expect(recordCitations(null, ["amount"], pageResolver(null))).toEqual({});
  });
});

describe("pruneCitations", () => {
  const cited = {
    boxes: [{ page: 1, left: 0, top: 0, width: 0.1, height: 0.1 }],
    printed: "x",
  };
  const citations: ExtractionCitations = {
    header: { entry_number: cited, mpf_amount: cited, hmf_amount: cited },
    lines: [
      {
        fields: { sku: cited, quantity: cited, entered_value: cited },
        charges: [{ rate: cited, amount: cited, hts_code: cited }],
      },
    ],
  };
  const fields: PortEntryExtraction = {
    entry_number: "231-1",
    entry_date: null,
    port_of_entry: null,
    entry_type: null,
    importer_of_record: null,
    referenced_bols: [],
    referenced_pos: [],
    referenced_invoices: [],
    total_entered_value: null,
    total_duty: null,
    mpf_amount: 33.58,
    hmf_amount: 0,
    line_items: [
      {
        line_number: 1,
        sku: null,
        description: null,
        hts_code: "8501.31.4000",
        country_of_origin: null,
        supplier_name: null,
        quantity: null,
        unit_value: null,
        entered_value: 100,
        charges: [
          { charge_type: "base_duty", hts_code: null, rate: 0.028, amount: 2.8 },
        ],
      },
    ],
  };

  it("drops citations for fields whose persisted value is null", () => {
    const out = pruneCitations(fields, citations);
    expect(Object.keys(out.lines[0].fields)).toEqual(["entered_value"]);
    expect(Object.keys(out.lines[0].charges[0])).toEqual(["rate", "amount"]);
    // No fee summary: the header fees keep the extractor's citation.
    expect(Object.keys(out.header)).toEqual([
      "entry_number",
      "mpf_amount",
      "hmf_amount",
    ]);
  });

  it("drops the header fees once Block 43 governs them", () => {
    const out = pruneCitations(
      { ...fields, fee_summary: [{ code: "499", amount: 33.58 }] },
      citations,
    );
    expect(Object.keys(out.header)).toEqual(["entry_number"]);
  });

  it("tolerates a citation shape longer than the mapped one", () => {
    const out = pruneCitations({ ...fields, line_items: [] }, citations);
    expect(out.lines).toEqual([{ fields: {}, charges: [] }]);
  });
});
