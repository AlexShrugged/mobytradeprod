import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import type { MeasureRef, ReferenceData } from "../duty/types";
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
    quantityUnit: "NO",
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

/** The seed reference with one code's USITC reporting unit overridden. */
function refWithUnit(
  base: ReferenceData,
  digits: string,
  unitOfQuantity: string | null,
): ReferenceData {
  const row = base.htsByDigits.get(digits);
  if (!row) throw new Error(`no seed HTS row for ${digits}`);
  const htsByDigits = new Map(base.htsByDigits);
  htsByDigits.set(digits, { ...row, unitOfQuantity });
  return { ...base, htsByDigits };
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
    quantityUnit: "PCS",
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

  it("accepts a header that leaves AD/CVD deposits out of block 37", () => {
    // Broker printouts follow either convention: block 37 "Duty" with or
    // without the block-39 antidumping deposit. $500 AD on the motor line;
    // both header readings reconcile, an unrelated gap still does not.
    const line = cleanMotorLine();
    line.charges = [
      ...line.charges,
      charge("antidumping", null, 0.05, "500.00"),
    ];
    const excluding = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "3900.00" }),
      ref,
    );
    expect(keys(excluding)).not.toContain("unreconciled:duty_total");
    const including = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "4400.00" }),
      ref,
    );
    expect(keys(including)).not.toContain("unreconciled:duty_total");
    const neither = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "4100.00" }),
      ref,
    );
    expect(keys(neither)).toContain("unreconciled:duty_total");
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

  // GSP (SPI A) has been lapsed since 2021-01-01: the column still lists
  // "A*", but the claim prices nothing. CBP's lapse guidance has filers
  // keep the SPI and pay the general rate, so that filing audits clean —
  // and a $0 base row beside the claim is not turned into duty owed.
  it("a lapsed-program claim paid at the general rate is the correct filing", () => {
    const line = korusLine({
      spi: "A",
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
    expect(keys(alerts)).toEqual([]);
  });

  it("a lapsed-program claim with no base duty stays silent", () => {
    const alerts = computeEntryAlerts(
      entry({ lines: [korusLine({ spi: "A" })], totalDuty: "1000.00" }),
      refWithSpecial,
    );
    expect(keys(alerts)).toEqual([]);
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
      sail: {
        earliestSail: "2026-08-02",
        latestSail: "2026-08-02",
        estimated: false,
      },
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

  it("stays silent on a misread rate when the dollars close against the official rate", () => {
    // ASC 231-7370776-8: the extractor read the printed 2.5% as 25% beside
    // a correctly charged amount. The dollars are the fact.
    const line = cleanMotorLine();
    const base = line.charges.find((ch) => ch.chargeType === "base_duty")!;
    base.rate = "0.4"; // 4% misread as 40%; the $400.00 is right
    expect(computeEntryAlerts(entry({ lines: [line] }), ref)).toEqual([]);

    const measure = cleanMotorLine();
    const c = measure.charges.find((ch) => ch.htsCode === "9903.88.01")!;
    c.rate = "0.025"; // 25% misread as 2.5%; the $2,500.00 is right
    expect(computeEntryAlerts(entry({ lines: [measure] }), ref)).toEqual([]);
  });

  it("still flags a wrong rate the amount follows, even inside the amount tolerance", () => {
    // 4.9% charged against the 4% schedule rate: $90 over on $10k entered
    // sits inside the 1% amount tolerance, so the rate rule is the only
    // thing that sees it.
    const line = cleanMotorLine();
    const base = line.charges.find((ch) => ch.chargeType === "base_duty")!;
    base.rate = "0.049";
    base.amount = "490.00";
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "3990.00" }),
      ref,
    );
    expect(keys(alerts)).toEqual(["rate_mismatch:line1:base"]);
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
    expect(
      alerts.find((a) => a.alertKey === "hts_discrepancy:line1")?.severity,
    ).toBe("warning");
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
        linkedInvoices: [invoice({ currency: "EUR", totalAmount: "10200.00" })],
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
            lines: [invoiceLine({ sku: "EB-BAT-48V", totalPrice: "20000.00" })],
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
      unit: "no",
      expected_quantity: 90,
      actual_quantity: 100,
      difference_quantity: 10,
    });
    expect(alerts[0].message).toBe(
      "EB-MTR-500W is entered with 100 pcs, but the commercial invoice bills 90 pcs.",
    );
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
        linkedInvoices: [invoice({ lines: [invoiceLine({ quantity: null })] })],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  // The unit gate: a 7501 reports net quantity in HTSUS units (kilograms
  // for most metal goods) while the invoice bills pieces — 1,065 kg against
  // 1,500 pcs is two measurements, never a variance.
  it("skips when the two sides are in different units (kg line vs piece-count invoice)", () => {
    const alerts = computeEntryAlerts(
      entry({
        lines: [cleanMotorLine({ quantity: "1065.0000", quantityUnit: "KG" })],
        linkedInvoices: [
          invoice({
            lines: [invoiceLine({ quantity: "1500.0000", quantityUnit: "PCS" })],
          }),
        ],
      }),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("skips when either side's unit is unknown", () => {
    // The invoice prints no unit.
    expect(
      computeEntryAlerts(
        entry({
          linkedInvoices: [
            invoice({
              lines: [invoiceLine({ quantity: "90.0000", quantityUnit: null })],
            }),
          ],
        }),
        ref,
      ),
    ).toEqual([]);
    // The 7501 prints no unit code and the schedule names none either
    // (the seed reference carries no reporting units).
    expect(
      computeEntryAlerts(
        entry({
          lines: [cleanMotorLine({ quantityUnit: null })],
          linkedInvoices: [
            invoice({ lines: [invoiceLine({ quantity: "90.0000" })] }),
          ],
        }),
        ref,
      ),
    ).toEqual([]);
    // An unrecognized spelling is unknown, not a new unit.
    expect(
      computeEntryAlerts(
        entry({
          linkedInvoices: [
            invoice({
              lines: [invoiceLine({ quantity: "90.0000", quantityUnit: "CTN" })],
            }),
          ],
        }),
        ref,
      ),
    ).toEqual([]);
  });

  it("falls back to the schedule's reporting unit for a unit-less 7501 line", () => {
    const unitLess = (r: ReferenceData) =>
      computeEntryAlerts(
        entry({
          lines: [cleanMotorLine({ quantityUnit: null })],
          linkedInvoices: [
            invoice({ lines: [invoiceLine({ quantity: "90.0000" })] }),
          ],
        }),
        r,
      );
    // Column 32 is net quantity in HTSUS units: a "No." code makes the
    // bare figure a piece count, comparable to the invoice's pieces.
    expect(keys(unitLess(refWithUnit(ref, "8501314000", "No.")))).toEqual([
      "quantity_discrepancy:invoice_sku:EB-MTR-500W",
    ]);
    // A kg code makes it a weight — not comparable to pieces.
    expect(unitLess(refWithUnit(ref, "8501314000", "kg"))).toEqual([]);
    // A two-unit code prints two figures on the 7501; one extracted number
    // cannot be attributed, so it stays unknown.
    expect(unitLess(refWithUnit(ref, "8501314000", "No., kg"))).toEqual([]);
  });

  it("recognizes spelling variants of one unit family", () => {
    const alerts = computeEntryAlerts(
      entry({
        lines: [cleanMotorLine({ quantityUnit: "NO" })],
        linkedInvoices: [
          invoice({
            lines: [invoiceLine({ quantity: "90.0000", quantityUnit: "pieces" })],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts)).toEqual([
      "quantity_discrepancy:invoice_sku:EB-MTR-500W",
    ]);
  });

  it("skips a SKU whose entry lines disagree on unit", () => {
    const alerts = computeEntryAlerts(
      entry({
        totalEnteredValue: "20000.00",
        totalDuty: "7800.00",
        lines: [
          cleanMotorLine({ quantity: "50.0000", quantityUnit: "NO" }),
          cleanMotorLine({
            id: "l2",
            lineNumber: 2,
            quantity: "40.0000",
            quantityUnit: "KG",
          }),
        ],
        linkedInvoices: [
          invoice({
            totalAmount: "20000.00",
            lines: [invoiceLine({ quantity: "90.0000", totalPrice: "20000.00" })],
          }),
        ],
      }),
      ref,
    );
    expect(keys(alerts).filter((k) => k.startsWith("quantity_"))).toEqual([]);
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
            lines: [invoiceLine({ sku: "NOT_FOUND", totalPrice: "20000.00" })],
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
        linkedInvoices: [invoice({ currency: "EUR", linkedEntryCount: 2 })],
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
    // Charge the 301 at the wrong rate (the amount follows it, the header
    // total agrees so the trust gate holds) — the rate and amount checks
    // must still fire alongside the reclassified signal.
    const c301 = line.charges.find((c) => c.htsCode === "9903.88.01")!;
    c301.rate = "0.2";
    c301.amount = "2000.00";
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "3400.00" }),
      ref,
    );
    expect(keys(alerts).sort()).toEqual([
      "amount_mismatch:line1:99038801",
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
    const alerts = computeEntryAlerts(
      entry({ lines: [exclusionLine()] }),
      windowed,
    );
    expect(keys(alerts)).not.toContain("unexpected_measure:line1:99038867");
  });

  it("flags the exclusion when the entry date falls outside its window", () => {
    const windowed = {
      ...ref,
      exemptionsByDigits: new Map([
        ["99038867", [{ effectiveDate: "2026-01-01", endDate: "2026-03-31" }]],
      ]),
    };
    const alerts = computeEntryAlerts(
      entry({ lines: [exclusionLine()] }),
      windowed,
    );
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
    line.charges.push(charge("additional_duty", "9903.99.05", null, "123.00"));
    const alerts = computeEntryAlerts(
      entry({ lines: [line], totalDuty: "4023.00" }),
      withSpecific,
    );
    expect(alerts).toEqual([]);
  });
});

describe("ceiling headings (in lieu of the column-1 rate)", () => {
  // Taiwan's note-52 heading over the motor code: 10% charged instead of
  // the 4% general rate, on lines whose column-1 rate is below 10%. The
  // at-or-above sibling (9903.05.75) is a $0 exemption row of the family.
  const ceiling: MeasureRef = {
    id: "tw-ceiling",
    name: "Trade measure — 9903.05.76",
    authority: "other",
    program: null,
    scope: "all_products",
    countries: ["TW"],
    effectiveDate: "2026-07-24",
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    inLieuOfBaseDuty: true,
    col1RateBelow: 0.1,
    ch99Code: "9903.05.76",
    ch99Digits: "99030576",
    rate: 0.1,
    exclusionDigits: ["99030575"],
    prefixes: [],
  };
  const motor = ref.htsByDigits.get("8501314000")!;
  const dear = { ...motor, code: "8501.31.9999", codeDigits: "8501319999", rate: 0.12 };
  const ceilingRef = {
    ...ref,
    htsByDigits: new Map(ref.htsByDigits).set(dear.codeDigits, dear),
    measures: [ceiling],
    stackingRules: [],
  };
  const entryDate = "2026-09-01";
  const fees = () => [
    charge("mpf", "499", 0.003464, "34.64"),
    charge("hmf", "501", 0.00125, "12.50"),
  ];
  function taiwanLine(
    charges: AuditableCharge[],
    htsCode = "8501.31.4000",
  ): AuditableLine {
    return cleanMotorLine({
      id: "tw1",
      sku: null,
      htsCode,
      htsCodeDigits: htsCode.replace(/\D/g, ""),
      countryOfOrigin: "TW",
      partHtsCode: null,
      partHtsCodeCurrent: null,
      charges,
    });
  }

  it("the broker's filing — $0 base duty beside the heading at its full rate — audits clean", () => {
    const line = taiwanLine([
      charge("base_duty", null, null, "0.00"),
      charge("additional_duty", "9903.05.76", 0.1, "1000.00"),
      ...fees(),
    ]);
    expect(
      computeEntryAlerts(
        entry({ entryDate, lines: [line], totalDuty: "1000.00" }),
        ceilingRef,
      ),
    ).toEqual([]);
  });

  it("no base duty row at all is not a missing base duty", () => {
    const line = taiwanLine([
      charge("additional_duty", "9903.05.76", 0.1, "1000.00"),
      ...fees(),
    ]);
    expect(
      keys(
        computeEntryAlerts(
          entry({ entryDate, lines: [line], totalDuty: "1000.00" }),
          ceilingRef,
        ),
      ),
    ).toEqual([]);
  });

  it("base duty charged anyway is an overpayment against the replaced rate", () => {
    const line = taiwanLine([
      charge("base_duty", "8501.31.4000", 0.04, "400.00"),
      charge("additional_duty", "9903.05.76", 0.1, "1000.00"),
      ...fees(),
    ]);
    const alerts = computeEntryAlerts(
      entry({ entryDate, lines: [line], totalDuty: "1400.00" }),
      ceilingRef,
    );
    expect(keys(alerts).sort()).toEqual([
      "amount_mismatch:line1:base",
      "rate_mismatch:line1:base",
    ]);
    for (const a of alerts) {
      expect(a.message).toContain("9903.05.76");
      expect(a.message).toContain("in lieu of the column-1 rate");
    }
    const amount = alerts.find((a) => a.alertType === "amount_mismatch")!;
    expect(amount.message).toContain("overpaid $400.00");
    expect(amount.details?.expected_amount).toBe(0);
  });

  it("the ceiling rate keyed onto the base-duty row beside a $0 heading audits clean", () => {
    // The other way brokers file the same dollars (ASC 231-7382025-6):
    // base duty at 10%, the heading declared at $0. The line pays exactly
    // the ceiling either way.
    const line = taiwanLine([
      charge("base_duty", "8501.31.4000", 0.1, "1000.00"),
      charge("additional_duty", "9903.05.76", null, "0.00"),
      ...fees(),
    ]);
    expect(
      computeEntryAlerts(
        entry({ entryDate, lines: [line], totalDuty: "1000.00" }),
        ceilingRef,
      ),
    ).toEqual([]);
  });

  it("the ceiling paid on the base-duty row AND on the heading still fires", () => {
    const line = taiwanLine([
      charge("base_duty", "8501.31.4000", 0.1, "1000.00"),
      charge("additional_duty", "9903.05.76", 0.1, "1000.00"),
      ...fees(),
    ]);
    expect(
      keys(
        computeEntryAlerts(
          entry({ entryDate, lines: [line], totalDuty: "2000.00" }),
          ceilingRef,
        ),
      ).sort(),
    ).toEqual(["amount_mismatch:line1:base", "rate_mismatch:line1:base"]);
  });

  it("the ceiling rate on the base-duty row with no heading declared is still a missing measure", () => {
    // Without the heading on the line nothing says the 10% is the ceiling:
    // the presentation reading needs the heading declared.
    const line = taiwanLine([
      charge("base_duty", "8501.31.4000", 0.1, "1000.00"),
      ...fees(),
    ]);
    expect(
      keys(
        computeEntryAlerts(
          entry({ entryDate, lines: [line], totalDuty: "1000.00" }),
          ceilingRef,
        ),
      ).sort(),
    ).toEqual([
      "amount_mismatch:line1:base",
      "missing_measure:line1:99030576",
      "rate_mismatch:line1:base",
    ]);
  });

  it("the heading itself missing is the shortfall", () => {
    const line = taiwanLine([charge("base_duty", null, null, "0.00"), ...fees()]);
    const alerts = computeEntryAlerts(
      entry({ entryDate, lines: [line], totalDuty: "0.00" }),
      ceilingRef,
    );
    expect(keys(alerts)).toEqual(["missing_measure:line1:99030576"]);
    expect(alerts[0].details?.expected_amount).toBe(1000);
  });

  it("a declared $0 exclusion of the heading's family keeps the column-1 rate (metals line)", () => {
    // ASC's real filing: a 232 metals line claims 9903.05.90 at $0 beside
    // its 50% charge and pays the 4% column-1 rate — the ceiling heading
    // is claimed away, so no base-duty alert may fire.
    const metals: MeasureRef = {
      ...ceiling,
      id: "metals",
      name: "Section 232 metals",
      authority: "section_232_steel",
      program: "section-232-metals-2026",
      scope: "hts_list",
      countries: null,
      inLieuOfBaseDuty: false,
      col1RateBelow: null,
      ch99Code: "9903.82.02",
      ch99Digits: "99038202",
      rate: 0.5,
      exclusionDigits: [],
      prefixes: ["8501"],
    };
    const family = { ...ceiling, exclusionDigits: ["99030575", "99030590"] };
    const withMetals = { ...ceilingRef, measures: [family, metals] };
    const line = taiwanLine([
      charge("base_duty", "8501.31.4000", 0.04, "400.00"),
      charge("additional_duty", "9903.05.90", 0, "0.00"),
      charge("additional_duty", "9903.82.02", 0.5, "5000.00"),
      ...fees(),
    ]);
    expect(
      computeEntryAlerts(
        entry({ entryDate, lines: [line], totalDuty: "5400.00" }),
        withMetals,
      ),
    ).toEqual([]);

    // And with the claim but no base row, the base duty is genuinely missing.
    const noBase = taiwanLine([
      charge("additional_duty", "9903.05.90", 0, "0.00"),
      charge("additional_duty", "9903.82.02", 0.5, "5000.00"),
      ...fees(),
    ]);
    const alerts = computeEntryAlerts(
      entry({ entryDate, lines: [noBase], totalDuty: "5000.00" }),
      withMetals,
    );
    expect(keys(alerts)).toEqual(["missing_base_duty:line1"]);
  });

  it("at or above the gate the column-1 rate stands and the $0 sibling is a statement", () => {
    const line = taiwanLine(
      [
        charge("base_duty", "8501.31.9999", 0.12, "1200.00"),
        charge("additional_duty", "9903.05.75", 0, "0.00"),
        ...fees(),
      ],
      "8501.31.9999",
    );
    expect(
      computeEntryAlerts(
        entry({ entryDate, lines: [line], totalDuty: "1200.00" }),
        ceilingRef,
      ),
    ).toEqual([]);
  });
});

describe("rule 17: MPF within the statutory bounds", () => {
  const mpfAlerts = (e: AuditableEntry) =>
    computeEntryAlerts(e, ref).filter((a) => a.alertType === "mpf_bounds");
  // FY2026 (entry() dates land in it): minimum $33.58, maximum $651.50.
  const smallLine = cleanMotorLine({ enteredValue: "4386.00" });
  const hugeLine = cleanMotorLine({ enteredValue: "280587.00" });

  it("stays silent on a fee inside the window and on fixtures without one", () => {
    // $10,000 × 0.3464% = $34.64, inside the window.
    expect(mpfAlerts(entry({ mpfAmount: "34.64" }))).toEqual([]);
    expect(mpfAlerts(entry())).toEqual([]);
  });

  it("flags the line-level ad valorem working persisted where Block 43 printed the minimum", () => {
    // 231-7385625-0 as extracted before fee-summary.ts: $15.19 vs $33.58.
    const [a] = mpfAlerts(
      entry({ mpfAmount: "15.19", totalEnteredValue: "4386.00", lines: [smallLine] }),
    );
    expect(a.alertKey).toBe("mpf_bounds:entry");
    expect(a.label).toBe("MPF below the minimum");
    expect(a.severity).toBe("error");
    expect(a.lineItemId).toBeNull();
    expect(a.details).toMatchObject({
      expected_amount: 33.58,
      actual_amount: 15.19,
      difference_amount: -18.39,
      ad_valorem_amount: 15.19,
      minimum_amount: 33.58,
      maximum_amount: 651.5,
      fiscal_year: 2026,
      bound: "minimum",
      exempt_line_numbers: [],
    });
    expect(a.message).toContain("FY2026 per-entry minimum of $33.58");
    expect(a.message).toContain("underpaid $18.39");
  });

  it("flags an uncapped header working where Block 43 printed the maximum", () => {
    // 231-7383835-7: $972.56 extracted, $651.50 collected.
    const [a] = mpfAlerts(
      entry({ mpfAmount: "972.56", totalEnteredValue: "280587.00", lines: [hugeLine] }),
    );
    expect(a.label).toBe("MPF above the maximum");
    expect(a.details).toMatchObject({
      expected_amount: 651.5,
      actual_amount: 972.56,
      difference_amount: 321.06,
      bound: "maximum",
    });
    expect(a.message).toContain("overpaid $321.06");
  });

  it("accepts the collected minimum and maximum as filed", () => {
    expect(mpfAlerts(entry({ mpfAmount: "33.58", lines: [smallLine] }))).toEqual([]);
    expect(mpfAlerts(entry({ mpfAmount: "651.50", lines: [hugeLine] }))).toEqual([]);
  });

  it("is claim-aware: exempt SPI lines leave the basis, an all-exempt entry expects no fee", () => {
    const korus = cleanMotorLine({ id: "k1", lineNumber: 1, enteredValue: "100000.00", spi: "KR" });
    const plain = cleanMotorLine({ id: "p2", lineNumber: 2, enteredValue: "20000.00" });
    // Basis = the $20,000 line only: $69.28.
    expect(mpfAlerts(entry({ mpfAmount: "69.28", lines: [korus, plain] }))).toEqual([]);
    const [mixed] = mpfAlerts(entry({ mpfAmount: "415.68", lines: [korus, plain] }));
    expect(mixed.details).toMatchObject({
      expected_amount: 69.28,
      basis_amount: 20000,
      exempt_line_numbers: [1],
      bound: "ad_valorem",
    });
    expect(mixed.message).toContain("lines without an exempt claim");
    const [exempt] = mpfAlerts(entry({ mpfAmount: "50.00", lines: [korus] }));
    expect(exempt.label).toBe("MPF on an exempt claim");
    expect(exempt.details).toMatchObject({ expected_amount: 0, bound: "exempt" });
    expect(exempt.message).toContain("SPI KR");
  });

  it("never turns an absent fee into a shortfall", () => {
    // No SPI, $0 collected: an exemption ACE accepted (LDBDC origin, chapter
    // 98), not a broker slip — the rule has no affirmative grounds.
    expect(mpfAlerts(entry({ mpfAmount: "0.00", lines: [hugeLine] }))).toEqual([]);
    expect(mpfAlerts(entry({ mpfAmount: null, lines: [hugeLine] }))).toEqual([]);
  });

  it("skips entry classes that owe no ad valorem MPF and dates before the known fiscal years", () => {
    expect(mpfAlerts(entry({ mpfAmount: "15.19", entryType: "11", lines: [smallLine] }))).toEqual([]);
    expect(mpfAlerts(entry({ mpfAmount: "15.19", entryType: "21", lines: [smallLine] }))).toEqual([]);
    expect(mpfAlerts(entry({ mpfAmount: "15.19", entryType: "03", lines: [smallLine] }))).toHaveLength(1);
    expect(mpfAlerts(entry({ mpfAmount: "15.19", entryDate: "2024-01-15", lines: [smallLine] }))).toEqual([]);
  });

  it("allows a cent a line of proration rounding", () => {
    const lines = [1, 2, 3].map((n) =>
      cleanMotorLine({ id: `r${n}`, lineNumber: n, enteredValue: "10000.00" }),
    );
    // $30,000 × 0.3464% = $103.92.
    expect(mpfAlerts(entry({ mpfAmount: "103.95", lines }))).toEqual([]);
    expect(mpfAlerts(entry({ mpfAmount: "103.96", lines }))).toHaveLength(1);
  });
});
