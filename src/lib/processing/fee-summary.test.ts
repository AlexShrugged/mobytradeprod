import { describe, expect, it } from "vitest";

import { applyFeeSummary, parseFeeSummary } from "./fee-summary";
import type { PortEntryExtraction } from "./types";

// Verbatim shapes from ASC 7501 parse text (2026-09-17).
const TABLE = `</td><td>N</td><td></td><td></td><td></td></tr></table>

| Other Fee Summary (for Block 43)   | Other Fee Summary (for Block 43)   |
|-|-|
| 501                                | 5.48                               |
| 499                                | 33.58                              |
|                                    |                                    |

39. Total Entered Value
$ 4,386
Total Other Fees
$ 39.06

40. Declaration of Importer of Record (Owner or Purchaser) or Authorized Agent`;

const BARE = `</td><td>N</td><td></td><td></td><td></td></tr></table>

Other Fee Summary (<i>for Block 43</i>)
501 1,397.59

39. Total Entered Value
$ 1,118,074
Total Other Fees
$ 1,397.59

40. Declaration of Importer of Record (Owner or Purchaser) or`;

const ADCVD = `| Other Fee Summary (for Block 43)   | Other Fee Summary (for Block 43)   |
|-|-|
| 501                                | 61.34                              |
| 499                                | 169.96                             |
| 012                                | 5,367.82                           |
| 013                                | 2,978.30                           |

39. Total Entered Value
$: 49,066
Total Other Fees
$: 8,577.42`;

const fields = (over: Partial<PortEntryExtraction> = {}): PortEntryExtraction => ({
  entry_number: "231-7385625-0",
  entry_date: "2026-09-21",
  port_of_entry: null,
  entry_type: "01",
  importer_of_record: null,
  referenced_bols: [],
  referenced_pos: [],
  referenced_invoices: [],
  total_entered_value: 4386,
  total_duty: 1890.37,
  mpf_amount: 15.19,
  hmf_amount: 5.48,
  line_items: [],
  ...over,
});

describe("parseFeeSummary", () => {
  it("reads the markdown-table rendering and checks it against the total", () => {
    expect(parseFeeSummary(TABLE)).toEqual({
      rows: [
        { code: "501", amount: 5.48 },
        { code: "499", amount: 33.58 },
      ],
      totalOtherFeesCents: 3906,
    });
  });

  it("reads the bare-line rendering with HTML in the heading and a grouped amount", () => {
    expect(parseFeeSummary(BARE)).toEqual({
      rows: [{ code: "501", amount: 1397.59 }],
      totalOtherFeesCents: 139759,
    });
  });

  it("keeps AD/CVD deposit rows beside the fees", () => {
    const parsed = parseFeeSummary(ADCVD);
    expect(parsed?.rows.map((r) => r.code)).toEqual(["501", "499", "012", "013"]);
    expect(parsed?.totalOtherFeesCents).toBe(857742);
  });

  it("refuses a block whose rows miss the printed total", () => {
    expect(parseFeeSummary(TABLE.replace("| 33.58", "| 3.58"))).toBeNull();
  });

  it("accepts a block that prints no total", () => {
    const noTotal = TABLE.replace(/Total Other Fees\n\$ 39\.06\n/, "");
    expect(parseFeeSummary(noTotal)?.rows).toHaveLength(2);
  });

  it("returns null without the heading or without rows", () => {
    expect(parseFeeSummary("39. Total Entered Value\n$ 4,386")).toBeNull();
    expect(parseFeeSummary("Other Fee Summary (for Block 43)\n\n39. Total Entered Value")).toBeNull();
  });
});

describe("applyFeeSummary", () => {
  it("replaces a line-level MPF working with the collected Block 43 figure", () => {
    const out = applyFeeSummary(fields(), TABLE);
    expect(out.mpf_amount).toBe(33.58);
    expect(out.hmf_amount).toBe(5.48);
    expect(out.fee_summary).toEqual([
      { code: "501", amount: 5.48 },
      { code: "499", amount: 33.58 },
    ]);
  });

  it("zeroes a fee the block does not list", () => {
    const out = applyFeeSummary(fields({ mpf_amount: null, hmf_amount: 1397.59 }), BARE);
    expect(out.mpf_amount).toBe(0);
    expect(out.hmf_amount).toBe(1397.59);
  });

  it("leaves the extraction alone when no block parses", () => {
    const input = fields();
    expect(applyFeeSummary(input, "no fee block here")).toBe(input);
    expect(applyFeeSummary(input, TABLE.replace("| 33.58", "| 3.58"))).toBe(input);
  });
});
