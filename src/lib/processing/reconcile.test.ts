import { describe, expect, it } from "vitest";

import {
  reconcilePortEntry,
  reconcileRetryAddendum,
} from "./reconcile";
import type {
  EntryChargeExtraction,
  EntryLineItemExtraction,
  PortEntryExtraction,
} from "./types";

const charge = (
  over: Partial<EntryChargeExtraction>,
): EntryChargeExtraction => ({
  charge_type: "additional_duty",
  hts_code: null,
  rate: null,
  amount: 0,
  ...over,
});

const line = (
  over: Partial<EntryLineItemExtraction>,
): EntryLineItemExtraction => ({
  line_number: 1,
  sku: null,
  description: null,
  hts_code: "7307.19.3040",
  country_of_origin: "TH",
  supplier_name: null,
  quantity: null,
  unit_value: null,
  entered_value: 0,
  charges: [],
  ...over,
});

const entry = (over: Partial<PortEntryExtraction>): PortEntryExtraction => ({
  entry_number: "231-7376568-3",
  entry_date: null,
  port_of_entry: null,
  entry_type: null,
  importer_of_record: null,
  referenced_bols: [],
  referenced_pos: [],
  referenced_invoices: [],
  total_entered_value: null,
  total_duty: null,
  mpf_amount: null,
  hmf_amount: null,
  line_items: [],
  ...over,
});

// ASC entry 231-7376568-3 line 001 as the extraction SHOULD read it.
const ascLine1 = () =>
  line({
    line_number: 1,
    hts_code: "7307.19.3040",
    quantity: 967,
    entered_value: 3039,
    charges: [
      charge({ hts_code: "9903.05.90", rate: null, amount: 0 }),
      charge({ hts_code: "9903.82.02", rate: 0.5, amount: 1519.5 }),
      charge({ charge_type: "base_duty", rate: 0.056, amount: 170.18 }),
      charge({ charge_type: "mpf", hts_code: "499", rate: 0.003464, amount: 10.53 }),
      charge({ charge_type: "hmf", hts_code: "501", rate: 0.00125, amount: 3.8 }),
    ],
  });

// ...and line 002.
const ascLine2 = () =>
  line({
    line_number: 2,
    hts_code: "7307.19.3060",
    quantity: 1602,
    entered_value: 5031,
    charges: [
      charge({ hts_code: "9903.05.90", rate: null, amount: 0 }),
      charge({ hts_code: "9903.82.02", rate: 0.5, amount: 2515.5 }),
      charge({ charge_type: "base_duty", rate: 0.056, amount: 281.74 }),
      charge({ charge_type: "mpf", hts_code: "499", rate: 0.003464, amount: 17.43 }),
      charge({ charge_type: "hmf", hts_code: "501", rate: 0.00125, amount: 6.29 }),
    ],
  });

describe("reconcilePortEntry line basis", () => {
  it("flags the ASC merged-line misread: two lines collapsed under the invoice-block trailer", () => {
    // The live failure on 231-7376568-3: extraction returned ONE line whose
    // entered value is the "Entered Value USD 8070" invoice-block subtotal
    // (3039 + 5031), carrying only line 001's charges. Both rated duty
    // charges agree the basis is $3,039.
    const merged = entry({
      line_items: [{ ...ascLine1(), entered_value: 8070 }],
    });
    const findings = reconcilePortEntry(merged);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("line_basis");
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].message).toContain("$8,070.00");
    expect(findings[0].message).toContain("$3,039.00");
    expect(findings[0].message).toContain("9903.82.02");
  });

  it("passes the faithful two-line extraction of the same page", () => {
    // 170.18 at 5.6% implies 3038.93 — inside the half-cent print-rounding
    // tolerance of the true 3039 basis.
    const faithful = entry({
      line_items: [ascLine1(), ascLine2()],
      total_entered_value: 8070,
      total_duty: 4486.92,
    });
    expect(reconcilePortEntry(faithful)).toEqual([]);
  });

  it("stays silent on a lone dissenting charge (Section 232 metal-content basis)", () => {
    // Base duty confirms the entered value; the 232 duty is computed on the
    // declared metal content value, a legitimately smaller basis. One
    // dissenter proves nothing.
    const contentSplit = entry({
      line_items: [
        line({
          entered_value: 10000,
          charges: [
            charge({ charge_type: "base_duty", rate: 0.029, amount: 290 }),
            charge({ hts_code: "9903.81.91", rate: 0.25, amount: 1000 }),
          ],
        }),
      ],
    });
    expect(reconcilePortEntry(contentSplit)).toEqual([]);
  });

  it("stays silent when the entered value keeps two corroborating charges even if others cluster elsewhere", () => {
    const mixed = entry({
      line_items: [
        line({
          entered_value: 10000,
          charges: [
            charge({ charge_type: "base_duty", rate: 0.029, amount: 290 }),
            charge({ hts_code: "9903.88.03", rate: 0.25, amount: 2500 }),
            // Two content-based 232 duties sharing a $4,000 content value.
            charge({ hts_code: "9903.81.91", rate: 0.25, amount: 1000 }),
            charge({ hts_code: "9903.85.08", rate: 0.25, amount: 1000 }),
          ],
        }),
      ],
    });
    expect(reconcilePortEntry(mixed)).toEqual([]);
  });

  it("stays silent with a single rated charge, even when it disagrees", () => {
    const lone = entry({
      line_items: [
        line({
          entered_value: 8070,
          charges: [charge({ hts_code: "9903.82.02", rate: 0.5, amount: 1519.5 })],
        }),
      ],
    });
    expect(reconcilePortEntry(lone)).toEqual([]);
  });

  it("does not let a duplicated charge corroborate itself", () => {
    const duplicated = entry({
      line_items: [
        line({
          entered_value: 8070,
          charges: [
            charge({ hts_code: "9903.82.02", rate: 0.5, amount: 1519.5 }),
            charge({ hts_code: "9903.82.02", rate: 0.5, amount: 1519.5 }),
          ],
        }),
      ],
    });
    expect(reconcilePortEntry(duplicated)).toEqual([]);
  });

  it("ignores MPF and HMF, whose caps break the rate proportion", () => {
    // A capped MPF implies a wildly smaller basis; it must never join a
    // cluster or trigger a finding.
    const capped = entry({
      line_items: [
        line({
          entered_value: 300000,
          charges: [
            charge({ charge_type: "base_duty", rate: 0.05, amount: 15000 }),
            charge({ charge_type: "mpf", hts_code: "499", rate: 0.003464, amount: 634.62 }),
            charge({ charge_type: "hmf", hts_code: "501", rate: 0.00125, amount: 375 }),
          ],
        }),
      ],
    });
    expect(reconcilePortEntry(capped)).toEqual([]);
  });

  it("flags a consensus basis against a zero entered value", () => {
    const zeroed = entry({
      line_items: [{ ...ascLine1(), entered_value: 0 }],
    });
    const findings = reconcilePortEntry(zeroed);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("line_basis");
  });
});

describe("reconcilePortEntry totals", () => {
  it("flags a dropped declaration line via the entered-value total", () => {
    const dropped = entry({
      line_items: [ascLine1()],
      total_entered_value: 8070,
    });
    const findings = reconcilePortEntry(dropped);
    expect(findings.map((f) => f.kind)).toContain("entered_value_total");
  });

  it("flags missing duty charges via the duty total", () => {
    const dropped = entry({
      line_items: [ascLine1()],
      total_duty: 4486.92,
    });
    const findings = reconcilePortEntry(dropped);
    expect(findings.map((f) => f.kind)).toContain("duty_total");
    expect(findings[0].message).toContain("$1,689.68");
  });

  it("skips totals checks when the header fields were not extracted", () => {
    const noTotals = entry({ line_items: [ascLine1()] });
    expect(reconcilePortEntry(noTotals)).toEqual([]);
  });

  it("excludes MPF/HMF from the duty-total comparison", () => {
    // total_duty is duty only; the line also carries MPF and HMF which must
    // not be counted toward it.
    const clean = entry({
      line_items: [ascLine1()],
      total_duty: 1689.68,
    });
    expect(reconcilePortEntry(clean)).toEqual([]);
  });
});

describe("reconcileRetryAddendum", () => {
  it("carries every finding and the invoice-trailer discipline", () => {
    const findings = reconcilePortEntry(
      entry({ line_items: [{ ...ascLine1(), entered_value: 8070 }] }),
    );
    const addendum = reconcileRetryAddendum(findings);
    expect(addendum).toContain(findings[0].message);
    expect(addendum).toContain("Invoice Value USD");
    expect(addendum).toContain("never merge numbered lines");
  });
});
