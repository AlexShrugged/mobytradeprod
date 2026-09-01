import { describe, expect, it } from "vitest";

import {
  junkSkuReason,
  parseResultText,
  scrubEntryLineSkus,
} from "./line-sku";
import type { EntryLineItemExtraction, PortEntryExtraction } from "./types";

const line = (
  line_number: number,
  sku: string | null,
  hts_code = "8481.80.3070",
): EntryLineItemExtraction => ({
  line_number,
  sku,
  description: "BALL TYPE OF STEEL,HAND OP",
  hts_code,
  spi: null,
  country_of_origin: "CN",
  supplier_name: null,
  quantity: 1,
  unit_value: null,
  entered_value: 6471,
  charges: [],
  adcvd_case_number: null,
  manufacturer_id: null,
});

const entry = (
  lines: EntryLineItemExtraction[],
  refs: Partial<
    Pick<
      PortEntryExtraction,
      "referenced_bols" | "referenced_pos" | "referenced_invoices"
    >
  > = {},
): PortEntryExtraction => ({
  entry_number: "231-7386387-6",
  entry_date: "2026-08-21",
  port_of_entry: "2704",
  entry_type: "01",
  importer_of_record: "ASC",
  referenced_bols: ["ONEYTPEG61194500"],
  referenced_pos: ["8120879"],
  referenced_invoices: ["23: 4607013"],
  total_entered_value: 6471,
  total_duty: 362.38,
  mpf_amount: 22.42,
  hmf_amount: 8.09,
  line_items: lines,
  adcvd_case_numbers: [],
  ...refs,
});

// The column-34 manifest block as Reducto parses it on an ASC 7501.
const PAGE_TEXT =
  '<tr><td rowspan="2">INV#</td><td colspan="3">204 KG 1 PCS\n' +
  "HB: EXD06810993766 1 PCS</td><td></td></tr>\n" +
  "<tr><td>001</td><td>ARTS</td><td>ALU,STL,COP,DER ALU, DER</td></tr>\n" +
  "<tr><td></td><td>PO#:</td><td>300-004183</td></tr>";

describe("junkSkuReason", () => {
  const f = entry([]);

  it("condemns a value carrying a reference label", () => {
    expect(junkSkuReason("HB EXD06840350959", f, null)).toBe(
      "labeled_reference",
    );
    expect(junkSkuReason("HB: EXD06840350959", f, null)).toBe(
      "labeled_reference",
    );
    expect(junkSkuReason("PO#: 300-004183", f, null)).toBe(
      "labeled_reference",
    );
    expect(junkSkuReason("B/L MEDUXL284254", f, null)).toBe(
      "labeled_reference",
    );
  });

  it("needs a separator after the label — a part number may start with those letters", () => {
    expect(junkSkuReason("PO-1234", f, null)).toBeNull();
    expect(junkSkuReason("BL2200", f, null)).toBeNull();
    expect(junkSkuReason("HBL123", f, null)).toBeNull();
    expect(junkSkuReason("INVX-77", f, null)).toBeNull();
  });

  it("condemns the value the extractor also reported as a document reference", () => {
    expect(
      junkSkuReason("300-004183", entry([], { referenced_pos: ["300-004183"] }), null),
    ).toBe("document_reference");
    // Formatting drift between the two fields does not hide the match.
    expect(
      junkSkuReason("300004183", entry([], { referenced_pos: ["300-004183"] }), null),
    ).toBe("document_reference");
    expect(junkSkuReason("ONEYTPEG61194500", f, null)).toBe(
      "document_reference",
    );
    expect(junkSkuReason("231-7386387-6", f, null)).toBe(
      "document_reference",
    );
  });

  it("condemns Chapter 99 article-text lead words", () => {
    expect(junkSkuReason("ARTS", f, null)).toBe("article_text");
    expect(junkSkuReason("prdts", f, null)).toBe("article_text");
  });

  it("condemns a bare value the page prints after a reference label", () => {
    expect(junkSkuReason("EXD06810993766", f, PAGE_TEXT)).toBe(
      "referenced_on_page",
    );
    // Without the page text the bare house bill is indistinguishable
    // from a part number — the on-page check is the only thing that
    // catches it, and it never fires without evidence.
    expect(junkSkuReason("EXD06810993766", f, null)).toBeNull();
  });

  it("keeps plausible part numbers, including ones on the page without a label", () => {
    expect(junkSkuReason("4356000040", f, PAGE_TEXT)).toBeNull();
    expect(junkSkuReason("EB-HUB-250", f, PAGE_TEXT)).toBeNull();
    expect(junkSkuReason("DT.WFSP", f, PAGE_TEXT)).toBeNull();
    expect(junkSkuReason("TUBE CUTTER", f, PAGE_TEXT)).toBeNull();
    // A value that only shares a prefix with a labeled reference is not
    // that reference.
    expect(junkSkuReason("EXD0681099376", f, PAGE_TEXT)).toBeNull();
  });
});

describe("scrubEntryLineSkus", () => {
  it("blanks junk skus and leaves the rest of the line untouched", () => {
    const f = entry([
      line(1, "EXD06810993766"),
      line(2, "ARTS", "7306.30.5056"),
      line(3, "4356000040"),
      line(4, null),
    ]);
    const out = scrubEntryLineSkus(f, PAGE_TEXT);
    expect(out.line_items.map((l) => l.sku)).toEqual([
      null,
      null,
      "4356000040",
      null,
    ]);
    expect(out.line_items[0].entered_value).toBe(6471);
    expect(out.line_items[0].hts_code).toBe("8481.80.3070");
    expect(out.referenced_pos).toEqual(["8120879"]);
  });

  it("returns the same object when nothing needs scrubbing", () => {
    const f = entry([line(1, "4356000040"), line(2, null)]);
    expect(scrubEntryLineSkus(f, PAGE_TEXT)).toBe(f);
  });
});

describe("parseResultText", () => {
  it("joins chunk contents", () => {
    expect(
      parseResultText({
        type: "full",
        chunks: [{ content: "a" }, { blocks: [] }, { content: "b" }],
      }),
    ).toBe("a\nb");
  });

  it("is empty for shapes it does not recognise", () => {
    expect(parseResultText(null)).toBe("");
    expect(parseResultText({ type: "url", url: "https://x" })).toBe("");
    expect(parseResultText({ chunks: "nope" })).toBe("");
  });
});
