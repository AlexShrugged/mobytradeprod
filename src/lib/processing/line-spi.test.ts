import { describe, expect, it } from "vitest";

import { fillEntryLineSpis, readLineSpis, splitCells } from "./line-spi";
import type {
  EntryChargeExtraction,
  EntryLineItemExtraction,
  PortEntryExtraction,
} from "./types";

// Cell renderings lifted from prod 7501s (Sobel for MotoRad, ASC's broker),
// reduced to the cells that matter. `td` wraps each cell like Reducto's
// HTML tables do.
const td = (...cells: string[]) => cells.map((c) => `<td>${c}</td>`).join("");
const row = (...cells: string[]) => `<tr>${td(...cells)}</tr>`;
const HEADER = row(
  "31\nLine\nNo.",
  "33.\nA. HTSUS Number",
  "35.\nNet Quantity in\nHTSUS Units",
  "D",
  "Dollars Cents",
);

const ref = (line_number: number, hts_code: string) => ({ line_number, hts_code });

describe("readLineSpis", () => {
  it("reads a lone symbol cell right before the HTS cell (both brokers)", () => {
    const sobel =
      HEADER +
      row("001 O,IL", "RECIP IL 15% DUTY\n9903.02.29 1731 KG", "0\nC5000", "15%", "106,775.70") +
      row("IL", "THERMOSTATS, OTHER\n9032.10.0090 82524.00 NO", "711,838", "Free", "0.00");
    expect(readLineSpis(sobel, [ref(1, "9032.10.0090")])).toEqual(new Map([[1, "IL"]]));

    const asc =
      HEADER +
      row("001", "PRDT OF SOUTH 9903.05.71", "KOREA 6207", "12.5%", "5911.25") +
      row("KR", "BUTTERFLY 8481.80.3030");
    expect(readLineSpis(asc, [ref(1, "8481.80.3030")])).toEqual(new Map([[1, "KR"]]));

    const gsp = HEADER + row("001", "10.0%", "11694.50") + row("A", "BUTTERFLY TYPE, 8481.80.3030");
    expect(readLineSpis(gsp, [ref(1, "8481.80.3030")])).toEqual(new Map([[1, "A"]]));
  });

  it("reads the symbol printed under the line number in Sobel's rowspan cell", () => {
    const text =
      HEADER +
      `<tr><td rowspan="6">001\n\nS</td><td colspan="7">I.T. DATE I.T. NO.\nPGKS87940745893 5 PAL</td></tr>` +
      row("Invoice Number", "001/EXP05162025-MLM", "N") +
      row("IEEPA-RECIPROCAL\n9903.01.27", "EXCLUSION MX\n2325 KG", "0\nC5000", "Free", "0.00") +
      row("MX EO USMCA\n9903.01.04 0.00\nOTH PRTS,ACCES,MOTOR VEHICLES\n8708.99.8180 31792.00 NO", "0", "Free", "0.00");
    expect(readLineSpis(text, [ref(1, "8708.99.8180")])).toEqual(new Map([[1, "S"]]));
  });

  it("reads an inline symbol just before the HTS in the same cell", () => {
    const text =
      HEADER +
      row("002", "AUTO PRT, LT TKS, NT33(G) 9903.94.05", "0.00") +
      row("LOCKS USED F/MOTR VEHICLES,OTH S 8301.20.0060") +
      row("003", "0.00") +
      row("IL 9032.10.0090 126790.00 NO 501 HARBOR MAINTENANCE FEE (HMF)");
    expect(readLineSpis(text, [ref(2, "8301.20.0060"), ref(3, "9032.10.0090")])).toEqual(
      new Map([
        [2, "S"],
        [3, "IL"],
      ]),
    );
  });

  it("reads a merged line-number cell up to the next line's number, skipping origin markers", () => {
    const text =
      HEADER +
      row("002 O,IL IL 003", "RECIP IL 15% DUTY 9903.02.29 16954 KG THERMOSTATS, OTHER", "0 C4882") +
      row("837,002", "Free", "0.00") +
      row("9032.10.0090 101904.00 NO") +
      row("007 O,CN 008 O,IL IL", "CN/HK EO 20% DUTY 9903.01.24 22 KG") +
      row("9903.88.03 0.00 OTH PRTS,ACCES,MOTOR VEHICLES 8708.99.8180 2500.00 NO") +
      row("APPLNC WITH THERMOST ACTUATOR 8481.80.9045 79566.00 NO");
    const lines = [ref(2, "9032.10.0090"), ref(7, "8708.99.8180"), ref(8, "8481.80.9045")];
    const got = readLineSpis(text, lines);
    expect(got.get(2)).toBe("IL");
    expect(got.has(7)).toBe(false); // the IL belongs to line 8
    expect(got.get(8)).toBe("IL");
  });

  it("never reads an origin or export marker as a claim", () => {
    const text =
      HEADER +
      row("003 O,IL", "RECIP IL 15%", "9903.02.29", "14566 KG") +
      row("001 IL O,IL E,IL", "OTH PRTS, ACCES, 8708.99.8180");
    // Line 3 prints only its origin; line 1 prints IL beside the markers.
    const got = readLineSpis(text + row("APPLNC 8481.80.9045 71390.00 NO"), [
      ref(1, "8708.99.8180"),
      ref(3, "8481.80.9045"),
    ]);
    expect(got.get(1)).toBe("IL");
    expect(got.has(3)).toBe(false);
  });

  it("finds a symbol elsewhere in the block only where an origin marker proves the layout", () => {
    const sobel =
      HEADER +
      row("004", "9903.02.29", "288 KG", "0", "15%", "1,822.35", "O,IL") +
      row("C103", "APPLNC WITH THERMOST ACTUATOR", "IL", "12,149", "Free", "0.00") +
      row("8481.80.9045 3400.00 NO 501 HARBOR MAINTENANCE FEE (HMF)");
    expect(readLineSpis(sobel, [ref(4, "8481.80.9045")])).toEqual(new Map([[4, "IL"]]));

    const marker =
      HEADER +
      row("003", "9903.02.29", "O,IL IL", "APPLNC WITH THERMOST ACTUATOR", "761,355", "Free", "0.00") +
      row("8481.80.9045 106209.00 NO");
    expect(readLineSpis(marker, [ref(3, "8481.80.9045")])).toEqual(new Map([[3, "IL"]]));

    // The same lone "IL" cell in a block with no marker could be a country
    // column — it is not read.
    const unproven =
      HEADER +
      row("003", "9903.02.29", "IL", "APPLNC WITH THERMOST ACTUATOR", "761,355", "Free", "0.00") +
      row("8481.80.9045 106209.00 NO");
    expect(readLineSpis(unproven, [ref(3, "8481.80.9045")])).toEqual(new Map());
  });

  it("does not read the retired NAFTA symbol out of a Chapter 99 description, and MX is a country", () => {
    const text =
      HEADER +
      row("001 MX EO USMCA 9903.01.04 280 KG", "0", "Free", "0.00", "C219") +
      row("S", "PLASTIC,STOPPERS, 3923.50.0000", "LIDS, CAPS");
    expect(readLineSpis(text, [ref(1, "3923.50.0000")])).toEqual(new Map([[1, "S"]]));
  });

  it("walks blocks in line order, so a continuation copy of the HTS is never a line's block", () => {
    const text =
      HEADER +
      row("001", "10.0%", "11694.50") +
      row("A", "BUTTERFLY TYPE, 8481.80.3030") +
      row("002", "10.0%", "10692.20") +
      row("KR", "BUTTERFLY TYPE, 8481.80.3030") +
      row("2 Commercial PRDTS OF CAMBODIA, 9903.05.28 BUTTERFLY TYPE, 8481.80.3030");
    expect(readLineSpis(text, [ref(1, "8481.80.3030"), ref(2, "8481.80.3030")])).toEqual(
      new Map([
        [1, "A"],
        [2, "KR"],
      ]),
    );
  });

  it("ignores the header's D column and a weight cell that starts with the line number", () => {
    const text =
      HEADER +
      row("5 KG", "25 NO", "223", "2.5%", "5.58", "O,TR") +
      row("005 IL O,IL", "OTH", "PRTS,ACCES,MOTOR VEHICLES") +
      row("8708.99.8180");
    expect(readLineSpis(text, [ref(5, "8708.99.8180")])).toEqual(new Map([[5, "IL"]]));
    expect(readLineSpis(HEADER + row("001", "WIDGET 8481.80.3030"), [ref(1, "8481.80.3030")])).toEqual(
      new Map(),
    );
  });

  it("leaves a line alone when two different symbols compete, and with no HTS in the text", () => {
    const text = HEADER + row("001 S", "IL", "THERMOSTATS 9032.10.0090");
    expect(readLineSpis(text, [ref(1, "9032.10.0090")])).toEqual(new Map());
    expect(readLineSpis(text, [ref(1, "8481.80.3030")])).toEqual(new Map());
  });

  it("splits HTML and markdown cells alike", () => {
    // Each tag boundary is a cell edge, so adjacent cells leave an empty
    // string between them — the reader skips empties.
    expect(splitCells("<td>A</td><td> 8481.80.3030 </td>")).toEqual([
      "",
      "A",
      "",
      "8481.80.3030",
      "",
    ]);
    expect(splitCells("| 001 | KR | 8481.80.3030 |")).toEqual(["", "001", "KR", "8481.80.3030", ""]);
  });
});

describe("fillEntryLineSpis", () => {
  const charge = (hts_code: string | null): EntryChargeExtraction => ({
    charge_type: "additional_duty",
    hts_code,
    rate: null,
    amount: 0,
  });
  const line = (
    line_number: number,
    hts_code: string,
    over: Partial<EntryLineItemExtraction> = {},
  ): EntryLineItemExtraction => ({
    line_number,
    sku: null,
    description: "THERMOSTATS, OTHER",
    hts_code,
    spi: null,
    country_of_origin: "IL",
    supplier_name: null,
    quantity: 1,
    unit_value: null,
    entered_value: 1000,
    charges: [],
    adcvd_case_number: null,
    manufacturer_id: null,
    ...over,
  });
  const entry = (lines: EntryLineItemExtraction[]): PortEntryExtraction => ({
    entry_number: "879-4081196-8",
    entry_date: "2025-12-17",
    port_of_entry: "2304",
    entry_type: "01",
    importer_of_record: "MOTORAD",
    referenced_bols: [],
    referenced_pos: [],
    referenced_invoices: [],
    total_entered_value: 1000,
    total_duty: 0,
    mpf_amount: null,
    hmf_amount: null,
    line_items: lines,
    adcvd_case_numbers: [],
  });
  const TEXT =
    HEADER +
    row("001 O,IL", "RECIP IL 15% DUTY") +
    row("IL", "THERMOSTATS, OTHER 9032.10.0090 82524.00 NO", "711,838", "Free", "0.00") +
    row("002", "CAPS 3923.50.0000 100 NO");

  it("fills only the blank lines from the text and keeps what the extractor returned", () => {
    const fields = entry([
      line(1, "9032.10.0090"),
      line(2, "3923.50.0000", { spi: "S", country_of_origin: "MX" }),
    ]);
    const filled = fillEntryLineSpis(fields, TEXT);
    expect(filled.line_items.map((l) => l.spi)).toEqual(["IL", "S"]);
    expect(fields.line_items[0].spi).toBeNull(); // input untouched
  });

  it("takes S from a declared USMCA heading when the text prints nothing", () => {
    const fields = entry([
      line(2, "3923.50.0000", { country_of_origin: "MX", charges: [charge("9903.01.04")] }),
      line(3, "3923.50.0000", { country_of_origin: "CN", charges: [charge("9903.01.04")] }),
      line(4, "3923.50.0000", { country_of_origin: "CA", charges: [charge("9903.01.14")] }),
    ]);
    const filled = fillEntryLineSpis(fields, "");
    expect(filled.line_items.map((l) => l.spi)).toEqual(["S", null, "S"]);
  });

  it("returns the same object when nothing changes", () => {
    const fields = entry([line(1, "9032.10.0090", { spi: "IL" })]);
    expect(fillEntryLineSpis(fields, TEXT)).toBe(fields);
    const blankNoText = entry([line(1, "9032.10.0090")]);
    expect(fillEntryLineSpis(blankNoText, null)).toBe(blankNoText);
  });
});
