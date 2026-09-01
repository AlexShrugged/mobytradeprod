import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import type { MeasureRef } from "../duty/types";
import {
  computeEntryAlerts,
  type AuditableCharge,
  type AuditableEntry,
  type AuditableInvoice,
  type AuditableInvoiceLine,
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
  const merged: AuditableLine = {
    id: "l1",
    lineNumber: 1,
    sku: "EB-MTR-500W",
    htsCode: "8501.31.4000",
    htsCodeDigits: "8501314000",
    countryOfOrigin: "CN",
    vendorId: null,
    enteredValue: "10000.00",
    quantity: "100.0000",
    partHtsCode: "8501.31.4000",
    partHtsCodeCurrent: "8501.31.4000",
    partHtsCurrentSince: null,
    partSources: [],
    charges: [
      charge("base_duty", "8501.31.4000", 0.04, "400.00"),
      charge("additional_duty", "9903.88.01", 0.25, "2500.00"),
      charge("additional_duty", "9903.01.25", 0.1, "1000.00"),
      charge("mpf", "499", 0.003464, "34.64"),
      charge("hmf", "501", 0.00125, "12.50"),
    ],
    ...over,
  };
  // Unless a test says otherwise, today's classification matches the as-of
  // one — the base fixture has no reclassification.
  if (over.partHtsCode !== undefined && over.partHtsCodeCurrent === undefined) {
    merged.partHtsCodeCurrent = over.partHtsCode;
  }
  return merged;
}

function entry(over: Partial<AuditableEntry> = {}): AuditableEntry {
  return {
    entryDate: "2026-06-10",
    totalEnteredValue: "10000.00",
    totalDuty: "3900.00",
    sail: null,
    lines: [cleanMotorLine()],
    linkedInvoices: [],
    ...over,
  };
}

// A CI line matching cleanMotorLine exactly — the clean baseline for the
// CI-vs-entry rules.
function invoiceLine(
  over: Partial<AuditableInvoiceLine> = {},
): AuditableInvoiceLine {
  return {
    sku: "EB-MTR-500W",
    htsCode: "8501.31.4000",
    htsCodeDigits: "8501314000",
    countryOfOrigin: "CN",
    quantity: "100.0000",
    totalPrice: "10000.00",
    ...over,
  };
}

function invoice(over: Partial<AuditableInvoice> = {}): AuditableInvoice {
  return {
    invoiceNumber: "INV-1001",
    currency: "USD",
    totalAmount: "10000.00",
    subtotal: null,
    adjustments: [],
    lines: [invoiceLine()],
    linkedEntryCount: 1,
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

describe("rule 1b: SPI preference claims", () => {
  const KORUS = "Free (A*, AU, BH, CL, CO, IL, JO, KR, MA, OM, S, SG)";
  const motorDigits = "8501314000";
  // The seed ref with a KORUS-style special-rates cell on the motor row.
  const refWithSpecial = {
    ...ref,
    htsByDigits: new Map(ref.htsByDigits).set(motorDigits, {
      ...ref.htsByDigits.get(motorDigits)!,
      col1Special: KORUS,
    }),
  };
  // KR motor line claiming KORUS: no base duty declared, reciprocal paid.
  function korusLine(over: Partial<AuditableLine> = {}): AuditableLine {
    return cleanMotorLine({
      countryOfOrigin: "KR",
      spi: "KR",
      charges: [
        charge("additional_duty", "9903.01.25", 0.1, "1000.00"),
        charge("mpf", "499", 0.003464, "34.64"),
        charge("hmf", "501", 0.00125, "12.50"),
      ],
      ...over,
    });
  }

  it("a schedule-supported claim silences the missing base duty alert", () => {
    const alerts = computeEntryAlerts(
      entry({ lines: [korusLine()], totalDuty: "1000.00" }),
      refWithSpecial,
    );
    expect(keys(alerts)).toEqual([]);
  });

  it("an unverifiable claim (no special-rates text) also stays silent", () => {
    // The plain seed ref carries no col1Special — the claim cannot be
    // checked, and a claim is never turned into duty owed without grounds.
    const alerts = computeEntryAlerts(
      entry({ lines: [korusLine()], totalDuty: "1000.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual([]);
  });

  it("an affirmatively unsupported claim fires, naming the rejected SPI", () => {
    const alerts = computeEntryAlerts(
      entry({ lines: [korusLine({ spi: "CA" })], totalDuty: "1000.00" }),
      refWithSpecial,
    );
    expect(keys(alerts)).toEqual(["missing_base_duty:line1"]);
    expect(alerts[0].message).toContain("SPI CA");
    expect(alerts[0].details?.claimed_spi).toBe("CA");
  });

  it("base duty paid at the general rate under an eligible claim mismatches", () => {
    const line = korusLine({
      charges: [
        charge("base_duty", "8501.31.4000", 0.04, "400.00"),
        charge("additional_duty", "9903.01.25", 0.1, "1000.00"),
        charge("mpf", "499", 0.003464, "34.64"),
        charge("hmf", "501", 0.00125, "12.50"),
      ],
    });
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "1400.00" }),
      refWithSpecial,
    );
    expect(keys(alerts)).toEqual([
      "rate_mismatch:line1:base",
      "amount_mismatch:line1:base",
    ]);
    expect(alerts[0].message).toContain("under SPI KR");
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

  // Section 122 vs the 232 program on one line: the headings are paired
  // bundles. 82-style liability (9903.85.08) pairs with the 122 carve-out
  // (9903.03.06 at $0); the no-content claim (9903.85.09 at $0) pairs with
  // 122 at 10%. Only a MIXED bundle is a finding.
  describe("cross-program carve-out (Section 122 vs 232)", () => {
    // Inside the 122 window, sail resolved exactly (no assumption alert).
    const IN_WINDOW = {
      entryDate: "2026-08-06",
      sail: { earliestSail: "2026-08-02", latestSail: "2026-08-02", estimated: false },
    };
    const frameLine = (charges: AuditableCharge[]) =>
      cleanMotorLine({
        sku: "EB-FRM-MTB",
        htsCode: "8714.91.3000",
        htsCodeDigits: "8714913000",
        countryOfOrigin: "TW",
        partHtsCode: "8714.91.3000",
        charges,
      });

    it("flags the mixed bundle: 232 charged AND 122 paid at 10% — the swap leg", () => {
      const line = frameLine([
        charge("base_duty", "8714.91.3000", 0.039, "390.00"),
        charge("additional_duty", "9903.85.08", 0.25, "2500.00"),
        charge("additional_duty", "9903.03.01", 0.1, "1000.00"),
      ]);
      const alerts = computeEntryAlerts(
        entry({ ...IN_WINDOW, lines: [line], totalDuty: "3890.00" }),
        ref,
      );
      expect(keys(alerts)).toEqual(["unexpected_measure:line1:99030301"]);
      expect(alerts[0].severity).toBe("warning");
      expect(alerts[0].message).toContain("9903.03.06");
      expect(alerts[0].details?.expected_exemption).toBe("9903.03.06");
    });

    it("accepts the alternative bundle: no-content claim + 122 at 10%", () => {
      // The declared 9903.85.09 exclusion asserts the 232 program does not
      // actually charge — then the 10% surcharge correctly stands.
      const line = frameLine([
        charge("base_duty", "8714.91.3000", 0.039, "390.00"),
        charge("additional_duty", "9903.85.09", 0, "0.00"),
        charge("additional_duty", "9903.03.01", 0.1, "1000.00"),
      ]);
      const alerts = computeEntryAlerts(
        entry({ ...IN_WINDOW, lines: [line], totalDuty: "1390.00" }),
        ref,
      );
      expect(alerts).toEqual([]);
    });

    it("accepts the correct bundle: 232 charged + 122 carve-out claimed at $0", () => {
      const line = frameLine([
        charge("base_duty", "8714.91.3000", 0.039, "390.00"),
        charge("additional_duty", "9903.85.08", 0.25, "2500.00"),
        charge("additional_duty", "9903.03.06", 0, "0.00"),
      ]);
      const alerts = computeEntryAlerts(
        entry({ ...IN_WINDOW, lines: [line], totalDuty: "2890.00" }),
        ref,
      );
      expect(alerts).toEqual([]);
    });

    it("emits both legs when 232 is missing outright and 122 was paid", () => {
      const line = frameLine([
        charge("base_duty", "8714.91.3000", 0.039, "390.00"),
        charge("additional_duty", "9903.03.01", 0.1, "1000.00"),
      ]);
      const alerts = computeEntryAlerts(
        entry({ ...IN_WINDOW, lines: [line], totalDuty: "1390.00" }),
        ref,
      );
      expect(keys(alerts)).toEqual([
        "missing_measure:line1:99038508",
        "unexpected_measure:line1:99030301",
      ]);
      // The two legs net: +$2,500 owed on the missing 232, −$1,000 back on
      // the displaced surcharge.
      expect(alerts[0].details?.expected_amount).toBe(2500);
      expect(alerts[1].details?.actual_amount).toBe(1000);
    });
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

describe("rule 10: COO vs catalog", () => {
  const shenzhen = {
    vendorId: "vendor-shenzhen",
    vendorName: "Shenzhen Volt Dynamics",
    countryOfOrigin: "CN",
  };
  const hanoi = {
    vendorId: "vendor-hanoi",
    vendorName: "Hanoi Precision Components",
    countryOfOrigin: "VN",
  };

  it("warns when the line's vendor sources this part from a different origin", () => {
    const line = cleanMotorLine({
      vendorId: "vendor-hanoi",
      partSources: [shenzhen, hanoi],
    });
    const alerts = computeEntryAlerts(entry({ lines: [line] }), ref);
    expect(keys(alerts)).toEqual(["coo_discrepancy:line1"]);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].message).toContain("Hanoi Precision Components");
    expect(alerts[0].details?.expected_coo).toBe("VN");
  });

  it("stays silent when the line's vendor source agrees with the declared COO", () => {
    const line = cleanMotorLine({
      vendorId: "vendor-shenzhen",
      partSources: [shenzhen, hanoi],
    });
    expect(computeEntryAlerts(entry({ lines: [line] }), ref)).toEqual([]);
  });

  it("with no line vendor, any source origin is acceptable", () => {
    // Declared CN, and one of the part's vendors ships CN — fine.
    const line = cleanMotorLine({ partSources: [shenzhen, hanoi] });
    expect(computeEntryAlerts(entry({ lines: [line] }), ref)).toEqual([]);
  });

  it("with no line vendor and no source carrying the declared COO, flags info", () => {
    const line = cleanMotorLine({
      countryOfOrigin: "CN",
      partSources: [hanoi],
    });
    const alerts = computeEntryAlerts(
      // CN charges under a VN-only catalog: keep the money side quiet by
      // matching the declared (CN) expectations — rule 10 is the only diff.
      entry({ lines: [line] }),
      ref,
    );
    expect(keys(alerts)).toEqual(["coo_discrepancy:line1"]);
    expect(alerts[0].severity).toBe("info");
    expect(alerts[0].details?.expected_coos).toEqual(["VN"]);
  });

  it("an unknown line vendor (no source row) falls back to the any-source check", () => {
    const line = cleanMotorLine({
      vendorId: "vendor-mystery",
      partSources: [shenzhen],
    });
    expect(computeEntryAlerts(entry({ lines: [line] }), ref)).toEqual([]);
  });

  it("never flags: null line COO, no sources, or all-null source COOs", () => {
    const noCoo = cleanMotorLine({
      countryOfOrigin: null,
      charges: [],
      partSources: [shenzhen],
    });
    expect(
      computeEntryAlerts(entry({ lines: [noCoo], totalDuty: null }), ref),
    ).toEqual([]);

    const noSources = cleanMotorLine({ partSources: [] });
    expect(computeEntryAlerts(entry({ lines: [noSources] }), ref)).toEqual([]);

    const nullCoos = cleanMotorLine({
      vendorId: "vendor-shenzhen",
      partSources: [{ ...shenzhen, countryOfOrigin: null }],
    });
    expect(computeEntryAlerts(entry({ lines: [nullCoos] }), ref)).toEqual([]);
  });

  it("does not suppress money checks — declared COO still drives rules 1-4", () => {
    const line = cleanMotorLine({
      vendorId: "vendor-hanoi",
      partSources: [hanoi],
    });
    const c = line.charges.find((ch) => ch.htsCode === "9903.88.01")!;
    c.amount = "1000.00"; // big amount mismatch on the declared-CN 301 line
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "2400.00" }),
      ref,
    );
    expect(keys(alerts)).toContain("coo_discrepancy:line1");
    expect(keys(alerts)).toContain("amount_mismatch:line1:99038801");
  });
});

describe("rule 16: SKU vs catalog (unknown SKU)", () => {
  it("warns on a declared SKU with no catalog part when the org has a catalog", () => {
    const line = cleanMotorLine({ sku: "EB-UNKNOWN-1", partId: null });
    const alerts = computeEntryAlerts(
      entry({ orgHasCatalog: true, lines: [line] }),
      ref,
    );
    expect(keys(alerts)).toContain("unknown_sku:line1");
    const alert = alerts.find((a) => a.alertType === "unknown_sku")!;
    expect(alert.severity).toBe("warning");
    expect(alert.message).toContain("EB-UNKNOWN-1");
    expect(alert.details?.sku).toBe("EB-UNKNOWN-1");
    expect(alert.lineItemId).toBe(line.id);
  });

  it("stays dormant when the org has no catalog at all", () => {
    const line = cleanMotorLine({ partId: null });
    const alerts = computeEntryAlerts(entry({ lines: [line] }), ref);
    expect(keys(alerts)).not.toContain("unknown_sku:line1");
    const gated = computeEntryAlerts(
      entry({ orgHasCatalog: false, lines: [line] }),
      ref,
    );
    expect(keys(gated)).not.toContain("unknown_sku:line1");
  });

  it("does not fire for a linked part (draft included) or a SKU-less line", () => {
    const linked = cleanMotorLine({ partId: "part-1" });
    const skuless = cleanMotorLine({ lineNumber: 2, sku: null, partId: null });
    const alerts = computeEntryAlerts(
      entry({ orgHasCatalog: true, lines: [linked, skuless] }),
      ref,
    );
    expect(keys(alerts).filter((k) => k.startsWith("unknown_sku"))).toEqual([]);
  });
});

describe("rule 6: header entered value vs line sum", () => {
  it("flags header entered value diverging from the line sum", () => {
    const alerts = computeEntryAlerts(
      entry({ totalEnteredValue: "12000.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:entered_value"]);
    expect(alerts[0].severity).toBe("error"); // $2,000 / 16.7% off
  });
});

describe("rule 8: invoice internal consistency", () => {
  it("flags an invoice whose header disagrees with its own line sum, and gates the entry comparison", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [invoice({ totalAmount: "10200.00" })], // lines: 10000
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:invoice:INV-1001"]);
    expect(alerts[0].severity).toBe("error"); // $200 > $50
  });

  it("runs on non-USD invoices too — internal consistency is currency-agnostic", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({ currency: "EUR", totalAmount: "10200.00" }),
        ],
      }),
      ref,
    );
    expect(keys(alerts).sort()).toEqual([
      "invoice_skipped:INV-1001",
      "value_mismatch:invoice:INV-1001",
    ]);
  });

  it("a clean CI matching the entry on every axis stays silent", () => {
    expect(
      computeEntryAlerts(entry({ linkedInvoices: [invoice()] }), ref),
    ).toEqual([]);
  });

  it("a rebate credit that explains the header gap is not a mismatch", () => {
    // The ASC shape: goods 10,000, "DEDUCE THE REBATE OF 2025" -2,000,
    // total amount 8,000. The 7501 declares the goods (10,000) — clean.
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "8000.00",
            subtotal: "10000.00",
            adjustments: [
              { label: "DEDUCE THE REBATE OF 2025", amount: "-2000.00" },
            ],
          }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("closes against the total less adjustments when no subtotal is printed", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "10350.00",
            adjustments: [{ label: "Ocean freight", amount: "350.00" }],
          }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("adjustments that do not explain the gap still fire, against the nearest figure", () => {
    // Lines 10,000; total 7,500 after a -2,000 rebate → the document's own
    // rows leave 500 unexplained.
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "7500.00",
            adjustments: [{ label: "REBATE", amount: "-2000.00" }],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:invoice:INV-1001"]);
    expect(alerts[0].message).toBe(
      "Invoice INV-1001 reports $7,500.00 after 1 adjustment(s) totaling -$2,000.00, but its 1 line(s) total $10,000.00, not $9,500.00.",
    );
    expect(alerts[0].details).toMatchObject({
      expected_amount: 9500,
      actual_amount: 10000,
      difference_amount: 500,
      total_amount: 7500,
      adjustments: [{ label: "REBATE", amount: -2000 }],
    });
  });
});

describe("rule 9: CI header value vs entered value", () => {
  it("fires with real money severity and carries the effective duty rate", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "20000.00",
            lines: [invoiceLine({ totalPrice: "20000.00" })],
          }),
        ],
      }),
      ref,
    );
    // The header failure gates open the per-SKU check (rule 11) too.
    expect(keys(alerts).sort()).toEqual([
      "value_mismatch:invoice_sku:EB-MTR-500W",
      "value_mismatch:invoice_total",
    ]);
    const total = alerts.find(
      (a) => a.alertKey === "value_mismatch:invoice_total",
    )!;
    expect(total.severity).toBe("error"); // $10k / 50% off
    expect(total.details).toMatchObject({
      expected_amount: 20000, // the CI is the document truth
      actual_amount: 10000, // the filed entry
      invoice_numbers: ["INV-1001"],
      // 4% base + 25% Section 301 + 10% reciprocal, value-weighted.
      effective_duty_rate: 0.39,
    });
  });

  it("boundary: tolerates max($1, 1% of CI total), fires beyond", () => {
    // $100 diff against a $10,100 CI is inside the 1% ($101) tolerance.
    const within = entry({
      linkedInvoices: [
        invoice({
          totalAmount: "10100.00",
          lines: [invoiceLine({ totalPrice: "10100.00" })],
        }),
      ],
    });
    expect(keys(computeEntryAlerts(within, ref))).toEqual([]);

    // $200 diff against a $10,200 CI breaches the 1% ($102) tolerance.
    const over = entry({
      linkedInvoices: [
        invoice({
          totalAmount: "10200.00",
          lines: [invoiceLine({ totalPrice: "10200.00" })],
        }),
      ],
    });
    expect(keys(computeEntryAlerts(over, ref))).toContain(
      "value_mismatch:invoice_total",
    );
  });

  it("compares the goods value, not the amount payable after a rebate", () => {
    // Goods 12,500 less a 2,500 rebate = 10,000 payable; the entry declares
    // 10,000. The document supports that figure too, so this is an info
    // comparison with no dollar claim — and the per-SKU rule stays closed.
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "10000.00",
            subtotal: "12500.00",
            adjustments: [
              { label: "DEDUCE THE REBATE OF 2025", amount: "-2500.00" },
            ],
            lines: [invoiceLine({ totalPrice: "12500.00" })],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["value_mismatch:invoice_total"]);
    expect(alerts[0].severity).toBe("info");
    expect(alerts[0].message).toBe(
      "The linked commercial invoice(s) INV-1001 bill $12,500.00 for the goods and $10,000.00 after DEDUCE THE REBATE OF 2025 (-$2,500.00); the entry declares $10,000.00, the adjusted total.",
    );
    expect(alerts[0].details).toMatchObject({
      expected_amount: 12500,
      actual_amount: 10000,
      adjusted_total: 10000,
      adjustments: [{ label: "DEDUCE THE REBATE OF 2025", amount: -2500 }],
    });
    expect(alerts[0].details).not.toHaveProperty("effective_duty_rate");
  });

  it("an entry matching neither the goods value nor the adjusted total is a real variance", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "11500.00",
            subtotal: "12500.00",
            adjustments: [{ label: "REBATE", amount: "-1000.00" }],
            lines: [invoiceLine({ totalPrice: "12500.00" })],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts).sort()).toEqual([
      "value_mismatch:invoice_sku:EB-MTR-500W",
      "value_mismatch:invoice_total",
    ]);
    const total = alerts.find(
      (a) => a.alertKey === "value_mismatch:invoice_total",
    )!;
    expect(total.severity).toBe("error");
    expect(total.details).toMatchObject({
      expected_amount: 12500, // the goods value, not the 11,500 payable
      actual_amount: 10000,
    });
  });

  it("skips silently when the invoice spans multiple entries", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "20000.00",
            lines: [invoiceLine({ totalPrice: "20000.00" })],
            linkedEntryCount: 2,
          }),
        ],
      }),
      ref,
    );
    // Normal consolidation — no finding of any kind.
    expect(alerts).toEqual([]);
  });

  it("skips value checks on a non-USD invoice, with an info notice instead", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            currency: "EUR",
            totalAmount: "20000.00",
            lines: [invoiceLine({ totalPrice: "20000.00" })],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["invoice_skipped:INV-1001"]);
    expect(alerts[0].alertType).toBe("invoice_comparison_skipped");
    expect(alerts[0].details).toMatchObject({
      currency: "EUR",
      reason: "non_usd_currency",
    });
  });

  it("incomplete SKU coverage yields sku_missing instead of a fake value variance", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "20000.00",
            lines: [
              invoiceLine({ sku: "EB-BAT-48V", totalPrice: "20000.00" }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual([
      "invoice_sku_missing:invoice_sku:EB-MTR-500W",
    ]);
    expect(alerts[0].severity).toBe("info");
    expect(alerts[0].details).toMatchObject({
      sku: "EB-MTR-500W",
      invoice_numbers: ["INV-1001"],
      line_number: 1,
    });
  });

  it("skips when an invoice has no header amount", () => {
    const alerts = computeEntryAlerts(
      entry({ linkedInvoices: [invoice({ totalAmount: null })] }),
      ref,
    );
    expect(alerts).toEqual([]);
  });
});

describe("rule 11: SKU-grouped value mismatch", () => {
  // A second entry line (battery) whose declared charges mirror the motor
  // line at half the value, so the duty rules stay quiet.
  const batteryLine = () =>
    cleanMotorLine({
      id: "l2",
      lineNumber: 2,
      sku: "EB-BAT-48V",
      enteredValue: "5000.00",
      quantity: "50.0000",
      charges: [
        charge("base_duty", "8501.31.4000", 0.04, "200.00"),
        charge("additional_duty", "9903.88.01", 0.25, "1250.00"),
        charge("additional_duty", "9903.01.25", 0.1, "500.00"),
        charge("mpf", "499", 0.003464, "17.32"),
        charge("hmf", "501", 0.00125, "6.25"),
      ],
    });
  const twoSkuEntry = (over: Partial<AuditableEntry> = {}) =>
    entry({
      lines: [cleanMotorLine(), batteryLine()],
      totalEnteredValue: "15000.00",
      totalDuty: "5850.00",
      ...over,
    });

  it("is gated on rule 9 — per-SKU deltas with a clean header total are noise", () => {
    // SKU sums shuffled ($2k moved between SKUs) but the invoice total
    // still matches the entry — nothing fires.
    const alerts = computeEntryAlerts(
      twoSkuEntry({
        linkedInvoices: [
          invoice({
            totalAmount: "15000.00",
            lines: [
              invoiceLine({ totalPrice: "12000.00" }),
              invoiceLine({
                sku: "EB-BAT-48V",
                quantity: "50.0000",
                totalPrice: "3000.00",
              }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(
      keys(alerts).filter((k) => k.startsWith("value_mismatch:invoice_sku")),
    ).toEqual([]);
  });

  it("is pairing-invariant — lines split across invoices with matching per-SKU sums stay silent", () => {
    // Two CIs slice the goods differently from the entry lines, but every
    // per-SKU sum agrees; the header check fires (entry over-declares
    // $1,000) yet no per-SKU alert may ride along.
    const alerts = computeEntryAlerts(
      twoSkuEntry({
        totalEnteredValue: "16000.00",
        linkedInvoices: [
          invoice({
            invoiceNumber: "INV-A",
            totalAmount: "6000.00",
            lines: [
              invoiceLine({ quantity: "60.0000", totalPrice: "6000.00" }),
            ],
          }),
          invoice({
            invoiceNumber: "INV-B",
            totalAmount: "9000.00",
            lines: [
              invoiceLine({ quantity: "40.0000", totalPrice: "4000.00" }),
              invoiceLine({
                sku: "EB-BAT-48V",
                quantity: "50.0000",
                totalPrice: "5000.00",
              }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts).sort()).toEqual([
      "value_mismatch:entered_value",
      "value_mismatch:invoice_total",
    ]);
  });

  it("flags the diverging SKU with the CI as expected and the entry as actual", () => {
    const alerts = computeEntryAlerts(
      entry({
        totalEnteredValue: "10000.00",
        linkedInvoices: [
          invoice({
            totalAmount: "9500.00",
            lines: [invoiceLine({ totalPrice: "9500.00" })],
          }),
        ],
      }),
      ref,
    );
    const sku = alerts.find(
      (a) => a.alertKey === "value_mismatch:invoice_sku:EB-MTR-500W",
    )!;
    expect(sku.details).toMatchObject({
      sku: "EB-MTR-500W",
      expected_amount: 9500,
      actual_amount: 10000,
      difference_amount: 500,
      invoice_numbers: ["INV-1001"],
      effective_duty_rate: 0.39,
    });
    expect(sku.lineItemId).toBe("l1");
  });
});

describe("rule 12: SKU-grouped quantity mismatch", () => {
  it("fires even when values match", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({ lines: [invoiceLine({ quantity: "90.0000" })] }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual([
      "quantity_discrepancy:invoice_sku:EB-MTR-500W",
    ]);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].alertType).toBe("quantity_discrepancy");
    expect(alerts[0].details).toMatchObject({
      expected_quantity: 90,
      actual_quantity: 100,
      difference_quantity: 10,
    });
  });

  it("boundary: silent at 0.01 units, fires above", () => {
    const at = entry({
      linkedInvoices: [
        invoice({ lines: [invoiceLine({ quantity: "100.0100" })] }),
      ],
    });
    expect(computeEntryAlerts(at, ref)).toEqual([]);

    const over = entry({
      linkedInvoices: [
        invoice({ lines: [invoiceLine({ quantity: "100.0200" })] }),
      ],
    });
    expect(keys(computeEntryAlerts(over, ref))).toEqual([
      "quantity_discrepancy:invoice_sku:EB-MTR-500W",
    ]);
  });

  it("skips SKUs where either side omits a quantity", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({ lines: [invoiceLine({ quantity: null })] }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("skips on non-USD invoices (gated with the value checks)", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            currency: "EUR",
            lines: [invoiceLine({ quantity: "90.0000" })],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["invoice_skipped:INV-1001"]);
  });
});

describe("rule 13: per-SKU HTS vs invoice", () => {
  it("warns when the shared prefix disagrees at the subheading", () => {
    // The CI prints a 6-digit HS code from a different heading.
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            lines: [
              invoiceLine({ htsCode: "8504.90", htsCodeDigits: "850490" }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual([
      "invoice_hts_mismatch:invoice_sku:EB-MTR-500W",
    ]);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].details).toMatchObject({
      expected_hts: "8504.90",
      actual_hts: "8501.31.4000",
      compared_digits: 6,
      invoice_numbers: ["INV-1001"],
    });
  });

  it("downgrades to info when only trailing digits differ (first six agree)", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            lines: [
              invoiceLine({
                htsCode: "8501.31.6000",
                htsCodeDigits: "8501316000",
              }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual([
      "invoice_hts_mismatch:invoice_sku:EB-MTR-500W",
    ]);
    expect(alerts[0].severity).toBe("info");
  });

  it("a CI code under 6 digits carries no comparable signal — silent", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            lines: [invoiceLine({ htsCode: "85", htsCodeDigits: "85" })],
          }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("silent when the CI code agrees on every shared digit", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            lines: [
              invoiceLine({ htsCode: "850131", htsCodeDigits: "850131" }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("never suppresses the money rules — CI evidence is weaker than the catalog", () => {
    const line = cleanMotorLine();
    const c = line.charges.find((ch) => ch.htsCode === "9903.88.01")!;
    c.amount = "1000.00"; // big amount mismatch
    const alerts = computeEntryAlerts(
      entry({
        lines: [line],
        totalDuty: "2400.00",
        linkedInvoices: [
          invoice({
            lines: [
              invoiceLine({ htsCode: "8504.90", htsCodeDigits: "850490" }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toContain("amount_mismatch:line1:99038801");
    expect(keys(alerts)).toContain(
      "invoice_hts_mismatch:invoice_sku:EB-MTR-500W",
    );
  });

  it("still runs on non-USD invoices — classification is currency-independent", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            currency: "EUR",
            lines: [
              invoiceLine({ htsCode: "8504.90", htsCodeDigits: "850490" }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts).sort()).toEqual([
      "invoice_hts_mismatch:invoice_sku:EB-MTR-500W",
      "invoice_skipped:INV-1001",
    ]);
  });
});

describe("rule 14: per-SKU COO vs invoice", () => {
  it("warns when the origin sets share nothing", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({ lines: [invoiceLine({ countryOfOrigin: "VN" })] }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual(["coo_discrepancy:invoice_sku:EB-MTR-500W"]);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].details).toMatchObject({
      declared_coo: "CN",
      expected_coo: "VN",
      invoice_number: "INV-1001",
    });
  });

  it("silent when the origin sets intersect", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            lines: [
              invoiceLine({
                countryOfOrigin: "CN",
                quantity: "50.0000",
                totalPrice: "5000.00",
              }),
              invoiceLine({
                countryOfOrigin: "VN",
                quantity: "50.0000",
                totalPrice: "5000.00",
              }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("silent when either side has no origin", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({ lines: [invoiceLine({ countryOfOrigin: null })] }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });
});

describe("rule 15: entry SKU missing from CI", () => {
  it("silent when the CI carries no real SKUs at all", () => {
    // A SKU-less CI says nothing about coverage — and it also blocks the
    // header value check, even with a diverging total.
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "20000.00",
            lines: [invoiceLine({ sku: null, totalPrice: "20000.00" })],
          }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("treats the extraction sentinel NOT_FOUND as no SKU", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({
            totalAmount: "20000.00",
            lines: [
              invoiceLine({ sku: "NOT_FOUND", totalPrice: "20000.00" }),
            ],
          }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });
});

describe("rule 9b: non-USD notices", () => {
  it("one notice per non-USD invoice", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({ invoiceNumber: "INV-EUR-1", currency: "EUR" }),
          invoice({ invoiceNumber: "INV-EUR-2", currency: "EUR" }),
        ],
      }),
      ref,
    );
    expect(keys(alerts).sort()).toEqual([
      "invoice_skipped:INV-EUR-1",
      "invoice_skipped:INV-EUR-2",
    ]);
  });

  it("no notice for a multi-entry invoice — that skip is silent by design", () => {
    const alerts = computeEntryAlerts(
      entry({
        linkedInvoices: [
          invoice({ currency: "EUR", linkedEntryCount: 2 }),
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

describe("rule 5b: reclassified after filing", () => {
  it("declared matching the as-of code with a changed current code raises only hts_reclassified", () => {
    const line = cleanMotorLine({
      partHtsCodeCurrent: "8501.31.6000",
      partHtsCurrentSince: "2026-07-01",
    });
    const alerts = computeEntryAlerts(entry({ lines: [line] }), ref);
    expect(keys(alerts)).toEqual(["hts_reclassified:line1"]);
    const a = alerts[0];
    expect(a.severity).toBe("info");
    expect(a.details).toMatchObject({
      declared_hts: "8501.31.4000",
      expected_hts_as_of: "8501.31.4000",
      expected_hts_current: "8501.31.6000",
      current_effective_from: "2026-07-01",
    });
  });

  it("money rules still run on a reclassified line", () => {
    const line = cleanMotorLine({
      partHtsCodeCurrent: "8501.31.6000",
      partHtsCurrentSince: "2026-07-01",
    });
    // Tamper the 301 rate only (amount stays right) — the trust gate holds
    // and the rate check must still fire alongside the reclassified signal.
    const c301 = line.charges.find((c) => c.htsCode === "9903.88.01")!;
    c301.rate = "0.2";
    const alerts = computeEntryAlerts(entry({ lines: [line] }), ref);
    expect(keys(alerts)).toEqual([
      "hts_reclassified:line1",
      "rate_mismatch:line1:99038801",
    ]);
  });

  it("a declaration off the as-of code stays hts_discrepancy, carrying both catalog codes", () => {
    const line = cleanMotorLine({
      partHtsCode: "8501.31.5000",
      partHtsCodeCurrent: "8501.31.6000",
    });
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: null }),
      ref,
    );
    expect(keys(alerts)).toContain("hts_discrepancy:line1");
    expect(keys(alerts)).not.toContain("hts_reclassified:line1");
    const a = alerts.find((x) => x.alertKey === "hts_discrepancy:line1")!;
    expect(a.details).toMatchObject({
      expected_hts: "8501.31.5000",
      expected_hts_as_of: "8501.31.5000",
      expected_hts_current: "8501.31.6000",
      actual_hts: "8501.31.4000",
    });
  });

  it("no signal when as-of, current, and declared all agree", () => {
    const alerts = computeEntryAlerts(entry(), ref);
    expect(alerts).toEqual([]);
  });
});

describe("rule 2: entry-date-windowed exemptions", () => {
  // Declared under the List 3 exclusion code 9903.88.67 at a nonzero
  // amount, in place of the expected List 1 charge. Whether that exclusion
  // claim is allowed depends on the window the ref carries for it.
  const exclusionLine = () => {
    const line = cleanMotorLine();
    const c301 = line.charges.find((c) => c.htsCode === "9903.88.01")!;
    c301.htsCode = "9903.88.67";
    c301.htsCodeDigits = "99038867";
    return line;
  };

  it("allows the exclusion when its window covers the entry date", () => {
    const windowed = {
      ...ref,
      exemptionsByDigits: new Map([
        ["99038867", [{ effectiveDate: "2026-01-01", endDate: null }]],
      ]),
    };
    const alerts = computeEntryAlerts(entry({ lines: [exclusionLine()] }), windowed);
    expect(keys(alerts)).not.toContain("unexpected_measure:line1:99038867");
  });

  it("flags the exclusion when the entry date falls outside its window", () => {
    const windowed = {
      ...ref,
      exemptionsByDigits: new Map([
        ["99038867", [{ effectiveDate: "2026-01-01", endDate: "2026-03-31" }]],
      ]),
    };
    const alerts = computeEntryAlerts(entry({ lines: [exclusionLine()] }), windowed);
    expect(keys(alerts)).toContain("unexpected_measure:line1:99038867");
  });

  it("falls back to the current-row exemption flag when the ref carries no windows", () => {
    // buildSeedReferenceData sets no exemptionsByDigits — the seed row's
    // exemption flag governs, the pre-windowing behavior.
    const alerts = computeEntryAlerts(entry({ lines: [exclusionLine()] }), ref);
    expect(keys(alerts)).not.toContain("unexpected_measure:line1:99038867");
  });
});

describe("non-ad-valorem (presence-only) measures", () => {
  // A specific-rate 232 measure covering the motor line — expected on the
  // entry, amount never auto-checked.
  const specific: MeasureRef = {
    id: "spec-1",
    name: "Port maintenance fee",
    authority: "other",
    scope: "hts_list",
    countries: null,
    effectiveDate: "2020-01-01",
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    inLieuOfBaseDuty: false,
    ch99Code: "9903.99.05",
    ch99Digits: "99039905",
    rate: null,
    rateType: "specific",
    rateText: "$80/net ton",
    exclusionDigits: [],
    prefixes: ["8501"],
  };
  const withSpecific = { ...ref, measures: [...ref.measures, specific] };

  it("absent charge → missing_measure with the raw rate text, no amount", () => {
    const alerts = computeEntryAlerts(entry(), withSpecific);
    expect(keys(alerts)).toEqual(["missing_measure:line1:99039905"]);
    expect(alerts[0].message).toContain("$80/net ton");
    expect(alerts[0].message).toContain("amount not auto-computed");
    expect(alerts[0].details?.expected_amount).toBeNull();
  });

  it("declared charge → presence satisfied, amount/rate never checked", () => {
    const line = cleanMotorLine();
    line.charges.push(
      charge("additional_duty", "9903.99.05", null, "123.00"),
    );
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "4023.00" }),
      withSpecific,
    );
    expect(alerts).toEqual([]);
  });
});
