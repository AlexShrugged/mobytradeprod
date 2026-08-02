// The sail-conditioned audit story, end to end through computeEntryAlerts
// against the seeded Section 122 tiled measures: the savings clause keeps a
// pre-cutoff entry clean, a missed grace window surfaces the missing
// surcharge, and estimated/assumed sail dates emit the Rule 5 info alert.

import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import type { SailInfo } from "../duty/types";
import {
  computeEntryAlerts,
  type AuditableEntry,
  type AuditableLine,
} from "./rules";

// Fixed anchor (2026-08-11) so the seed's day-relative Section 122 pair
// lands on a deterministic timeline: cutoff day(-10) = 2026-08-01, last
// pre-cutoff sail day(-11) = 2026-07-31, grace deadline day(+7) =
// 2026-08-18, grace-missed row effective day(+8) = 2026-08-19.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const ref = buildSeedReferenceData(day);

function charge(
  chargeType: AuditableLine["charges"][number]["chargeType"],
  htsCode: string,
  rate: number | null,
  amount: string,
) {
  return {
    id: `c-${htsCode}`,
    chargeType,
    htsCode,
    htsCodeDigits: htsCode.replace(/\D/g, ""),
    rate: rate === null ? null : String(rate),
    amount,
  };
}

// A CN motor line whose declared charges match the June 2026 expectation:
// 4% base + 301 List 1 (25%) + reciprocal (10%). Section 122 (Aug 2026+)
// is deliberately NOT declared — the tests pivot on whether it's expected.
function motorLine(): AuditableLine {
  return {
    id: "li-1",
    lineNumber: 1,
    sku: "EB-MTR-750",
    htsCode: "8501.31.4000",
    htsCodeDigits: "8501314000",
    countryOfOrigin: "CN",
    enteredValue: "10000.00",
    partHtsCode: "8501.31.4000",
    charges: [
      charge("base_duty", "8501.31.4000", 0.04, "400.00"),
      charge("additional_duty", "9903.88.01", 0.25, "2500.00"),
      charge("additional_duty", "9903.01.25", 0.1, "1000.00"),
    ],
  };
}

function entry(
  entryDate: string,
  sail: SailInfo | null,
  totalDuty = "3900.00",
): AuditableEntry {
  return {
    entryDate,
    totalEnteredValue: "10000.00",
    totalDuty,
    sail,
    lines: [motorLine()],
    linkedPos: [],
    linkedInvoices: [],
  };
}

const sailedOn = (d: string, estimated = false): SailInfo => ({
  earliestSail: d,
  latestSail: d,
  estimated,
});

const keys = (alerts: { alertKey: string }[]) => alerts.map((a) => a.alertKey);

describe("Section 122 savings clause through the audit rules", () => {
  it("sailed pre-cutoff and entered within grace: clean, no sail alert", () => {
    const alerts = computeEntryAlerts(
      entry("2026-08-05", sailedOn("2026-07-16")),
      ref,
    );
    expect(alerts).toEqual([]);
  });

  it("sailed pre-cutoff but entered past grace: surcharge goes missing", () => {
    // Entered 2026-08-20, past the day(+8) = 2026-08-19 grace-missed row.
    const alerts = computeEntryAlerts(
      entry("2026-08-20", sailedOn("2026-07-16")),
      ref,
    );
    expect(keys(alerts)).toContain("missing_measure:line1:99030301");
    // Known sail date — grounded exactly, so no assumption alert.
    expect(keys(alerts)).not.toContain("sail_assumption:entry");
  });

  it("a declared in-transit exemption code satisfies the surcharge", () => {
    const line = motorLine();
    line.charges.push(charge("additional_duty", "9903.03.02", 0, "0.00"));
    const alerts = computeEntryAlerts(
      { ...entry("2026-08-20", sailedOn("2026-07-16")), lines: [line] },
      ref,
    );
    expect(keys(alerts)).not.toContain("missing_measure:line1:99030301");
  });

  it("ETD-estimated sail date emits the Rule 5 info alert", () => {
    const alerts = computeEntryAlerts(
      entry("2026-08-05", sailedOn("2026-07-16", true)),
      ref,
    );
    expect(keys(alerts)).toEqual(["sail_assumption:entry"]);
    const alert = alerts[0];
    expect(alert.alertType).toBe("sail_date_assumption");
    expect(alert.severity).toBe("info");
    expect(alert.details).toMatchObject({
      sail_basis: "estimated",
      line_numbers: [1],
    });
  });

  it("no sail data at all: surcharge assumed owed AND flagged", () => {
    const alerts = computeEntryAlerts(entry("2026-08-05", null), ref);
    expect(keys(alerts)).toContain("missing_measure:line1:99030301");
    const assumption = alerts.find(
      (a) => a.alertKey === "sail_assumption:entry",
    );
    expect(assumption?.details).toMatchObject({ sail_basis: "assumed" });
  });

  it("pre-effective entries never evaluate sail conditions", () => {
    const alerts = computeEntryAlerts(entry("2026-06-10", null), ref);
    expect(alerts).toEqual([]);
  });
});
