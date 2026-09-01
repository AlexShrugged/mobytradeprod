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

  it("flags the ASC gross-weight misread: column 34 taken as every line's entered value", () => {
    // The live failure on 231-7387976-5 (packet 7077841183): each line's
    // entered value came back as the column-34 gross weight printed
    // beside the Chapter 99 code (2097/2297/2116/161 kg) while the
    // quantities read correctly. On every line both rated charges agree
    // on the real column-36 value, so all four lines are provable — and
    // the header total (which the real values sum to exactly) catches the
    // same misread even on a line with a single rated charge.
    const weightsAsValues = entry({
      total_entered_value: 19336,
      total_duty: 5715.33,
      line_items: [
        line({
          line_number: 1,
          hts_code: "7307.19.3060",
          quantity: 1924,
          entered_value: 2097,
          charges: [
            charge({ hts_code: "9903.05.90", rate: null, amount: 0 }),
            charge({ hts_code: "9903.82.02", rate: 0.5, amount: 2954 }),
            charge({ charge_type: "base_duty", rate: 0.056, amount: 330.85 }),
            charge({ charge_type: "mpf", hts_code: "499", rate: 0.003464, amount: 20.47 }),
          ],
        }),
        line({
          line_number: 2,
          hts_code: "7307.19.3060",
          quantity: 2108,
          entered_value: 2297,
          charges: [
            charge({ hts_code: "9903.05.77", rate: 0.125, amount: 808.88 }),
            charge({ hts_code: "9903.82.01", rate: null, amount: 0 }),
            charge({ charge_type: "base_duty", rate: 0.056, amount: 362.38 }),
          ],
        }),
        line({
          line_number: 3,
          hts_code: "7307.19.3040",
          quantity: 1942,
          entered_value: 2116,
          charges: [
            charge({ hts_code: "9903.05.77", rate: 0.125, amount: 745 }),
            charge({ charge_type: "base_duty", rate: 0.056, amount: 333.76 }),
          ],
        }),
        line({
          line_number: 4,
          hts_code: "8481.80.3030",
          quantity: 5,
          entered_value: 161,
          charges: [
            charge({ hts_code: "9903.05.77", rate: 0.125, amount: 124.63 }),
            charge({ charge_type: "base_duty", rate: 0.056, amount: 55.83 }),
          ],
        }),
      ],
    });
    const findings = reconcilePortEntry(weightsAsValues);
    expect(findings.map((f) => f.kind)).toEqual([
      "line_basis",
      "line_basis",
      "line_basis",
      "line_basis",
      "entered_value_total",
    ]);
    expect(findings[1].message).toContain("$2,297.00");
    expect(findings[1].message).toContain("$6,471.04");
    // The faithful read of the same page reconciles on every axis.
    const faithful = {
      ...weightsAsValues,
      line_items: weightsAsValues.line_items.map((item, i) => ({
        ...item,
        entered_value: [5908, 6471, 5960, 997][i],
      })),
    };
    expect(reconcilePortEntry(faithful)).toEqual([]);
  });

  it("catches the gross-weight misread on single-charge lines through the header total", () => {
    // 231-7387056-6: lines whose only rated charge is one Chapter 99 duty
    // (base duty free) — no consensus possible per line, but the misread
    // values (weights) fall far short of the header total the real
    // values sum to.
    const singleCharge = entry({
      total_entered_value: 20194,
      line_items: [
        line({
          line_number: 1,
          hts_code: "8481.90.1000",
          entered_value: 4400,
          charges: [
            charge({ hts_code: "9903.05.76", rate: 0.1, amount: 733.8 }),
            charge({ charge_type: "base_duty", rate: null, amount: 0 }),
          ],
        }),
        line({
          line_number: 2,
          hts_code: "8481.30.1090",
          entered_value: 6520,
          charges: [
            charge({ hts_code: "9903.05.76", rate: 0.1, amount: 1086.6 }),
            charge({ charge_type: "base_duty", rate: null, amount: 0 }),
          ],
        }),
        line({
          line_number: 3,
          hts_code: "7412.20.0035",
          entered_value: 1990,
          charges: [
            charge({ hts_code: "9903.82.02", rate: 0.5, amount: 995 }),
            charge({ charge_type: "base_duty", rate: 0.03, amount: 59.7 }),
          ],
        }),
      ],
    });
    expect(reconcilePortEntry(singleCharge).map((f) => f.kind)).toEqual([
      "entered_value_total",
    ]);
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

  it("accepts a header duty total under either AD/CVD convention", () => {
    // 231-7379174-7 line 002: a $701.63 antidumping deposit that the
    // broker's block-37 total leaves to block 39 "Other". The official
    // form does the same; other printouts fold deposits into the total.
    // A faithful extraction reconciles either way — and both docs that
    // failed closed on prod over this gap were faithful.
    const withDeposit = (
      totalDuty: number,
      charges: EntryChargeExtraction[],
    ) =>
      entry({
        total_duty: totalDuty,
        line_items: [line({ entered_value: 9910, charges })],
      });
    const charges = [
      charge({ hts_code: "9903.88.03", rate: 0.25, amount: 2477.5 }),
      charge({ hts_code: "9903.82.02", rate: 0.5, amount: 4955 }),
      charge({ charge_type: "base_duty", rate: 0.056, amount: 554.96 }),
      charge({
        charge_type: "antidumping",
        hts_code: "A-570-875",
        rate: 0.0708,
        amount: 701.63,
      }),
    ];
    // Deposits excluded (2477.50 + 4955 + 554.96) and included (+701.63).
    expect(reconcilePortEntry(withDeposit(7987.46, charges))).toEqual([]);
    expect(reconcilePortEntry(withDeposit(8689.09, charges))).toEqual([]);
    // A dropped base duty still misses the header under both conventions
    // (7,432.50 excluding the deposit, 8,134.13 including it).
    const dropped = charges.filter((c) => c.charge_type !== "base_duty");
    const findings = reconcilePortEntry(withDeposit(7987.46, dropped));
    expect(findings.map((f) => f.kind)).toEqual(["duty_total"]);
    expect(findings[0].message).toContain("$7,987.46");
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
