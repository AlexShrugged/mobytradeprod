import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import {
  computeEntryAlerts,
  type AuditableCharge,
  type AuditableEntry,
  type AuditableLine,
} from "./rules";

// Fixed anchor (2026-08-11) — see calculator.test.ts. Entry dates here
// predate the Section 122 cutoff (day(-10) = 2026-08-01), so the surcharge
// never enters these expectations.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const ref = buildSeedReferenceData(day);

let chargeId = 0;
function charge(
  chargeType: AuditableCharge["chargeType"],
  htsCode: string | null,
  rate: number | null,
  amount: string,
): AuditableCharge {
  return {
    id: `c${++chargeId}`,
    chargeType,
    htsCode,
    htsCodeDigits: htsCode ? htsCode.replace(/\D/g, "") : null,
    rate: rate === null ? null : String(rate),
    amount,
  };
}

// A clean CN motor line: $10,000 entered, base 4%, 301 List 1 25%,
// reciprocal 10%, MPF, HMF. Declared duty-type total: $3,900.
function cleanMotorLine(over: Partial<AuditableLine> = {}): AuditableLine {
  return {
    id: "l1",
    lineNumber: 1,
    sku: "EB-MTR-500W",
    htsCode: "8501.31.4000",
    htsCodeDigits: "8501314000",
    countryOfOrigin: "CN",
    enteredValue: "10000.00",
    partHtsCode: "8501.31.4000",
    charges: [
      charge("base_duty", "8501.31.4000", 0.04, "400.00"),
      charge("additional_duty", "9903.88.01", 0.25, "2500.00"),
      charge("additional_duty", "9903.01.25", 0.1, "1000.00"),
      charge("mpf", "499", 0.003464, "34.64"),
      charge("hmf", "501", 0.00125, "12.50"),
    ],
    ...over,
  };
}

function entry(over: Partial<AuditableEntry> = {}): AuditableEntry {
  return {
    entryDate: "2026-06-10",
    totalEnteredValue: "10000.00",
    totalDuty: "3900.00",
    sail: null,
    lines: [cleanMotorLine()],
    linkedPos: [],
    linkedInvoices: [],
    ...over,
  };
}

const keys = (alerts: { alertKey: string }[]) => alerts.map((a) => a.alertKey);

describe("clean entries", () => {
  it("a fully consistent entry produces zero alerts", () => {
    expect(computeEntryAlerts(entry(), ref)).toEqual([]);
  });
});

describe("rule 0: trust gate", () => {
  it("suspends compliance rules when charges do not reconcile with the header", () => {
    // Line is missing its 301 charge AND the header disagrees with the
    // declared sum — only the unreconciled alert may surface.
    const line = cleanMotorLine();
    line.charges = line.charges.filter((c) => c.htsCode !== "9903.88.01");
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "3900.00" }), // declared now 1400
      ref,
    );
    expect(keys(alerts)).toEqual(["unreconciled:duty_total"]);
    expect(alerts[0].severity).toBe("info");
  });

  it("tolerates small differences (max of $2 or 1%)", () => {
    const alerts = computeEntryAlerts(entry({ totalDuty: "3901.50" }), ref);
    expect(alerts).toEqual([]);
  });
});

describe("rule 1: missing measure", () => {
  it("flags an expected measure with no declared charge", () => {
    const line = cleanMotorLine();
    line.charges = line.charges.filter((c) => c.htsCode !== "9903.88.01");
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "1400.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual(["missing_measure:line1:99038801"]);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].details?.expected_amount).toBe(2500);
  });

  it("a declared $0 exclusion code satisfies its parent measure", () => {
    // CN battery: 301 List 3 expected; the filer claims exclusion
    // 9903.88.67 at $0 instead. That is a statement, not a gap.
    const line = cleanMotorLine({
      htsCode: "8507.60.0020",
      htsCodeDigits: "8507600020",
      sku: "EB-BAT-48V",
      partHtsCode: "8507.60.0020",
      charges: [
        charge("base_duty", "8507.60.0020", 0.034, "340.00"),
        charge("additional_duty", "9903.88.67", 0, "0.00"),
        charge("additional_duty", "9903.01.25", 0.1, "1000.00"),
      ],
    });
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "1340.00" }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("flags a dutiable schedule rate with no base duty charge", () => {
    const line = cleanMotorLine();
    line.charges = line.charges.filter((c) => c.chargeType !== "base_duty");
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "3500.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual(["missing_base_duty:line1"]);
  });
});

describe("rule 2: unexpected measure", () => {
  it("warns with the stacking reason when the measure was suppressed", () => {
    // TW aluminum frame: 232 expected, reciprocal suppressed — but declared.
    const line = cleanMotorLine({
      sku: "EB-FRM-MTB",
      htsCode: "8714.91.3000",
      htsCodeDigits: "8714913000",
      countryOfOrigin: "TW",
      partHtsCode: "8714.91.3000",
      charges: [
        charge("base_duty", "8714.91.3000", 0.039, "390.00"),
        charge("additional_duty", "9903.85.08", 0.25, "2500.00"),
        charge("additional_duty", "9903.01.25", 0.1, "1000.00"),
      ],
    });
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "3890.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual(["unexpected_measure:line1:99030125"]);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].message).toContain("E.O. 14257");
    expect(alerts[0].details?.stacking_reason).toContain("Section 232");
  });

  it("treats an unknown Chapter 99 code as an info-level coverage gap", () => {
    const line = cleanMotorLine();
    line.charges.push(charge("additional_duty", "9903.77.77", 0.05, "500.00"));
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "4400.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual(["unexpected_measure:line1:99037777"]);
    expect(alerts[0].severity).toBe("info");
    expect(alerts[0].message).toContain("coverage gap");
  });
});

describe("rules 3 & 4: rate and amount mismatches", () => {
  it("flags a wrong rate and its consistent wrong amount", () => {
    const line = cleanMotorLine();
    const c = line.charges.find((ch) => ch.htsCode === "9903.88.01")!;
    c.rate = "0.2";
    c.amount = "2000.00";
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "3400.00" }),
      ref,
    );
    expect(keys(alerts).sort()).toEqual([
      "amount_mismatch:line1:99038801",
      "rate_mismatch:line1:99038801",
    ]);
    // $500 off on both — over the $50 error threshold.
    for (const a of alerts) expect(a.severity).toBe("error");
  });

  it("tolerates amounts within max($0.02, 1% of entered value)", () => {
    const line = cleanMotorLine();
    const c = line.charges.find((ch) => ch.htsCode === "9903.88.01")!;
    c.amount = "2450.00"; // $50 off, tolerance is $100 on $10k entered
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "3850.00" }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("never flags a $0 amount — that is an exclusion claim", () => {
    const line = cleanMotorLine();
    const c = line.charges.find((ch) => ch.htsCode === "9903.88.01")!;
    c.rate = "0.25";
    c.amount = "0.00";
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "1400.00" }),
      ref,
    );
    expect(keys(alerts)).not.toContain("amount_mismatch:line1:99038801");
  });
});

describe("rule 5: HTS vs catalog", () => {
  it("downgrades to info when the first six digits agree", () => {
    const line = cleanMotorLine({
      htsCode: "8714.94.9000",
      htsCodeDigits: "8714949000",
      countryOfOrigin: "TW",
      partHtsCode: "8714.94.3080",
      charges: [
        charge("base_duty", "8714.94.9000", 0.1, "1000.00"),
        charge("additional_duty", "9903.01.25", 0.1, "1000.00"),
      ],
    });
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "2000.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual(["hts_discrepancy:line1"]);
    expect(alerts[0].severity).toBe("info");
  });

  it("warns on a different heading and suppresses money checks on that line", () => {
    const line = cleanMotorLine({
      partHtsCode: "8714.94.3080", // catalog says brakes, declared says motor
    });
    const c = line.charges.find((ch) => ch.htsCode === "9903.88.01")!;
    c.amount = "1000.00"; // would be a big amount mismatch
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "2400.00" }),
      ref,
    );
    expect(keys(alerts)).toContain("hts_discrepancy:line1");
    expect(keys(alerts)).not.toContain("amount_mismatch:line1:99038801");
    expect(alerts.find((a) => a.alertKey === "hts_discrepancy:line1")?.severity).toBe(
      "warning",
    );
  });

  it("a corrected catalog code clears the discrepancy AND re-enables money checks", () => {
    // Same line as above, but the catalog now agrees with the declaration —
    // the mismatch that classification doubt was hiding must surface.
    const line = cleanMotorLine({ partHtsCode: "8501.31.4000" });
    const c = line.charges.find((ch) => ch.htsCode === "9903.88.01")!;
    c.amount = "1000.00";
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "2400.00" }),
      ref,
    );
    expect(keys(alerts)).not.toContain("hts_discrepancy:line1");
    expect(keys(alerts)).toContain("amount_mismatch:line1:99038801");
  });

  it("a null catalog code (unlinked part, draft, or provisional-only) never flags", () => {
    const alerts = computeEntryAlerts(
      entry({ lines: [cleanMotorLine({ partHtsCode: null })] }),
      ref,
    );
    expect(keys(alerts)).not.toContain("hts_discrepancy:line1");
  });
});

describe("rules 6 & 7: header value checks", () => {
  it("flags header entered value diverging from the line sum", () => {
    const alerts = computeEntryAlerts(
      entry({ totalEnteredValue: "12000.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:entered_value"]);
    expect(alerts[0].severity).toBe("error"); // $2,000 / 16.7% off
  });

  it("notes PO totals diverging from entered value, info only", () => {
    const alerts = computeEntryAlerts(
      entry({ linkedPos: [{ poNumber: "PO-1", totalAmount: "20000.00" }] }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:po_total"]);
    expect(alerts[0].severity).toBe("info");
  });

  it("skips the PO check when any linked PO lacks a total", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedPos: [
          { poNumber: "PO-1", totalAmount: "20000.00" },
          { poNumber: "PO-2", totalAmount: null },
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });
});

describe("rules 8 & 9: invoice checks", () => {
  it("flags an invoice whose header disagrees with its own line sum", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          {
            invoiceNumber: "INV-1001",
            totalAmount: "10200.00",
            lineTotalSum: "10000.00",
            lineCount: 3,
          },
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:invoice:INV-1001"]);
    expect(alerts[0].severity).toBe("error"); // $200 > $50
  });

  it("notes invoice totals diverging from entered value, info only", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          {
            invoiceNumber: "INV-1001",
            totalAmount: "20000.00",
            lineTotalSum: "20000.00",
            lineCount: 2,
          },
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:invoice_total"]);
    expect(alerts[0].severity).toBe("info");
  });

  it("suppresses the aggregate check when any invoice is internally inconsistent", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          {
            invoiceNumber: "INV-1001",
            totalAmount: "20000.00",
            lineTotalSum: "18000.00",
            lineCount: 2,
          },
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:invoice:INV-1001"]);
  });

  it("an invoice matching both its lines and the entry stays silent", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          {
            invoiceNumber: "INV-1001",
            totalAmount: "10000.00",
            lineTotalSum: "10000.00",
            lineCount: 2,
          },
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });
});

describe("gates", () => {
  it("skips measure and money rules without an entry date", () => {
    const line = cleanMotorLine();
    line.charges = line.charges.filter((c) => c.htsCode !== "9903.88.01");
    const alerts = computeEntryAlerts(
      entry({ entryDate: null, lines: [line], totalDuty: "1400.00" }),
      ref,
    );
    expect(keys(alerts)).not.toContain("missing_measure:line1:99038801");
  });

  it("skips lines with no charges at all — an ingestion gap, not a finding", () => {
    const line = cleanMotorLine({ charges: [] });
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: null }),
      ref,
    );
    expect(alerts).toEqual([]);
  });
});
