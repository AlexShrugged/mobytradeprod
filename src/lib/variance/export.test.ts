import { describe, expect, it } from "vitest";

import { varianceCsv, type VarianceExportRow } from "./export";

const base: VarianceExportRow = {
  alertType: "rate_mismatch",
  label: "Duty mismatch",
  message: "Declared rate 20%, expected 25%.",
  details: { expected_rate: 0.25, actual_rate: 0.2 },
  status: "open",
  entryNumber: "231-4501311-9",
  lineNumber: 1,
  sku: "EB-MTR-750W",
  description: "750W Mid-Drive Motor",
  impactCents: -173700,
  window: { estDate: "2027-03-30", closed: false },
};

const lines = (csv: string) => csv.split("\r\n");

describe("varianceCsv", () => {
  it("renders header plus one row per finding, ending with CRLF", () => {
    const csv = varianceCsv([base]);
    const rows = lines(csv);
    expect(rows[0]).toContain("Entry number,Line,SKU");
    expect(rows).toHaveLength(3); // header, row, trailing empty
    expect(rows[2]).toBe("");
  });

  it("maps the field diff and keys the row by entry + line", () => {
    const row = lines(varianceCsv([base]))[1];
    expect(row).toBe(
      "231-4501311-9,1,EB-MTR-750W,750W Mid-Drive Motor,Duty mismatch," +
        "Duty rate,20%,25%,,open,-1737.00,2027-03-30," +
        '"Declared rate 20%, expected 25%."',
    );
  });

  it("fills Corrected from the decision: accepted keeps Expected", () => {
    const row = lines(varianceCsv([{ ...base, status: "resolved" }]))[1];
    const cells = row.split(",");
    expect(cells[8]).toBe("25%");
    expect(cells[9]).toBe("accepted");
  });

  it("fills Corrected from the decision: dismissed keeps Filed", () => {
    const row = lines(varianceCsv([{ ...base, status: "dismissed" }]))[1];
    const cells = row.split(",");
    expect(cells[8]).toBe("20%");
    expect(cells[9]).toBe("dismissed");
  });

  it("escapes quotes and commas per RFC 4180", () => {
    const csv = varianceCsv([
      {
        ...base,
        description: 'Motor, "mid-drive"',
        message: "a,b",
      },
    ]);
    expect(csv).toContain('"Motor, ""mid-drive"""');
    expect(csv).toContain('"a,b"');
  });

  it("marks liquidated windows and formats signed dollars", () => {
    const row = lines(
      varianceCsv([
        {
          ...base,
          impactCents: 162000,
          window: { estDate: "2027-01-01", closed: true },
        },
      ]),
    )[1];
    const cells = row.split(",");
    expect(cells[10]).toBe("1620.00");
    expect(cells[11]).toBe("liquidated");
  });

  it("leaves diff cells empty for findings without a field-level diff", () => {
    const row = lines(
      varianceCsv([
        {
          ...base,
          alertType: "data_unreconciled",
          label: "Charge data unreconciled",
          details: {},
          impactCents: null,
        },
      ]),
    )[1];
    const cells = row.split(",");
    expect(cells[5]).toBe(""); // field
    expect(cells[6]).toBe(""); // filed
    expect(cells[7]).toBe(""); // expected
    expect(cells[10]).toBe(""); // impact
  });
});
