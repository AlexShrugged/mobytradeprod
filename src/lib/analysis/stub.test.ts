import { describe, expect, it } from "vitest";

import { computeEntryAlerts } from "../audit/rules";
import { StubEntryAnalyst, alertToFinding } from "./stub";
import { fixtureBundle, fixtureRef as ref } from "./test-fixtures";

describe("StubEntryAnalyst", () => {
  it("re-expresses every deterministic alert as a finding", async () => {
    const bundle = fixtureBundle();
    const alerts = computeEntryAlerts(bundle.snapshot.auditable, ref);
    expect(alerts.length).toBeGreaterThan(0);

    const result = await new StubEntryAnalyst().analyze(bundle, ref);
    expect(result.analyst).toBe("stub");
    expect(result.error).toBeNull();
    expect(result.report.findings).toHaveLength(alerts.length);
    expect(result.report.findings.map((f) => f.relatedAlertKeys[0])).toEqual(
      alerts.map((a) => a.alertKey),
    );
  });

  it("is deterministic across runs", async () => {
    const stub = new StubEntryAnalyst();
    const a = await stub.analyze(fixtureBundle(), ref);
    const b = await stub.analyze(fixtureBundle(), ref);
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  });

  it("maps alert types onto finding categories", () => {
    const base = {
      alertKey: "x",
      severity: "warning" as const,
      label: "L",
      message: "M",
      details: null,
      lineItemId: null,
    };
    expect(
      alertToFinding({ ...base, alertType: "missing_measure" }).category,
    ).toBe("duty_calculation");
    expect(
      alertToFinding({ ...base, alertType: "hts_discrepancy" }).category,
    ).toBe("classification_mismatch");
    expect(
      alertToFinding({ ...base, alertType: "coo_discrepancy" }).category,
    ).toBe("coo_inconsistency");
    expect(
      alertToFinding({ ...base, alertType: "value_mismatch" }).category,
    ).toBe("valuation_concern");
    expect(
      alertToFinding({ ...base, alertType: "data_unreconciled" }).category,
    ).toBe("document_inconsistency");
  });

  it("recovers line numbers from alert keys", () => {
    const base = {
      alertType: "missing_measure" as const,
      severity: "warning" as const,
      label: "L",
      message: "M",
      details: null,
      lineItemId: null,
    };
    expect(
      alertToFinding({ ...base, alertKey: "missing_measure:line3:9903" })
        .lineNumber,
    ).toBe(3);
    expect(
      alertToFinding({ ...base, alertKey: "unreconciled:duty_total" })
        .lineNumber,
    ).toBeNull();
  });
});
