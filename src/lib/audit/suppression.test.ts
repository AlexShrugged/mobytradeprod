// The suppression partition, pure: alert-type gating, each scope axis,
// AND-composition, fail-closed behavior on missing facts, and first-match
// attribution. Alerts are hand-built — suppression never looks at reference
// data, only the desired alerts and the entry's line facts.

import { describe, expect, it } from "vitest";

import type { SuppressionSpec } from "../org-rules";
import type { AuditableEntry, AuditableLine, DesiredAlert } from "./rules";
import { applySuppressions, type SuppressionRule } from "./suppression";

function line(over: Partial<AuditableLine> & { id: string }): AuditableLine {
  return {
    lineNumber: 1,
    sku: null,
    htsCode: "8501.31.4000",
    htsCodeDigits: "8501314000",
    countryOfOrigin: "CN",
    vendorId: null,
    enteredValue: "1000.00",
    quantity: null,
    partHtsCode: null,
    partHtsCodeCurrent: null,
    partHtsCurrentSince: null,
    partSources: [],
    charges: [],
    ...over,
  };
}

function entry(lines: AuditableLine[]): AuditableEntry {
  return {
    entryDate: "2026-08-01",
    totalEnteredValue: null,
    totalDuty: null,
    sail: null,
    lines,
    linkedInvoices: [],
  };
}

function alert(
  over: Partial<DesiredAlert> & Pick<DesiredAlert, "alertKey" | "alertType">,
): DesiredAlert {
  return {
    severity: "warning",
    label: "Test alert",
    message: "Test alert.",
    details: null,
    lineItemId: null,
    ...over,
  };
}

function rule(
  id: string,
  suppression: Partial<SuppressionSpec> &
    Pick<SuppressionSpec, "alertTypes">,
): SuppressionRule {
  return {
    id,
    text: `rule ${id}`,
    suppression: {
      supplierName: null,
      countryOfOrigin: null,
      htsPrefix: null,
      ...suppression,
    },
  };
}

const keys = (alerts: DesiredAlert[]) => alerts.map((a) => a.alertKey);

describe("applySuppressions", () => {
  it("no rules is the identity", () => {
    const alerts = [alert({ alertKey: "a", alertType: "missing_measure" })];
    const out = applySuppressions(alerts, entry([]), []);
    expect(out.kept).toBe(alerts);
    expect(out.suppressed).toEqual([]);
  });

  it("type-only rule suppresses line- and entry-level alerts of that type", () => {
    const li = line({ id: "li-1" });
    const out = applySuppressions(
      [
        alert({ alertKey: "mm:1", alertType: "missing_measure", lineItemId: "li-1" }),
        alert({ alertKey: "mm:entry", alertType: "missing_measure" }),
        alert({ alertKey: "rm:1", alertType: "rate_mismatch", lineItemId: "li-1" }),
      ],
      entry([li]),
      [rule("r1", { alertTypes: ["missing_measure"] })],
    );
    expect(keys(out.kept)).toEqual(["rm:1"]);
    expect(out.suppressed.map((s) => s.alert.alertKey)).toEqual([
      "mm:1",
      "mm:entry",
    ]);
  });

  it("supplier scope matches case- and whitespace-insensitively", () => {
    const lines = [
      line({ id: "li-1", supplierName: "  Shenzhen Drivetrain CO " }),
      line({ id: "li-2", supplierName: "Other Supplier" }),
    ];
    const out = applySuppressions(
      [
        alert({ alertKey: "a1", alertType: "missing_measure", lineItemId: "li-1" }),
        alert({ alertKey: "a2", alertType: "missing_measure", lineItemId: "li-2" }),
      ],
      entry(lines),
      [rule("r1", { alertTypes: ["missing_measure"], supplierName: "shenzhen drivetrain co" })],
    );
    expect(keys(out.kept)).toEqual(["a2"]);
    expect(out.suppressed[0]?.alert.alertKey).toBe("a1");
  });

  it("a line without a supplier never supplier-matches (fails closed)", () => {
    const out = applySuppressions(
      [alert({ alertKey: "a1", alertType: "missing_measure", lineItemId: "li-1" })],
      entry([line({ id: "li-1", supplierName: null })]),
      [rule("r1", { alertTypes: ["missing_measure"], supplierName: "Anyone" })],
    );
    expect(keys(out.kept)).toEqual(["a1"]);
  });

  it("COO and HTS-prefix scopes each filter; dotted prefixes normalize", () => {
    const lines = [
      line({ id: "li-cn", countryOfOrigin: "CN" }),
      line({ id: "li-vn", countryOfOrigin: "VN", htsCodeDigits: "8714961000" }),
    ];
    const cooOut = applySuppressions(
      [
        alert({ alertKey: "cn", alertType: "coo_discrepancy", lineItemId: "li-cn" }),
        alert({ alertKey: "vn", alertType: "coo_discrepancy", lineItemId: "li-vn" }),
      ],
      entry(lines),
      [rule("r1", { alertTypes: ["coo_discrepancy"], countryOfOrigin: "CN" })],
    );
    expect(keys(cooOut.kept)).toEqual(["vn"]);

    const htsOut = applySuppressions(
      [
        alert({ alertKey: "cn", alertType: "rate_mismatch", lineItemId: "li-cn" }),
        alert({ alertKey: "vn", alertType: "rate_mismatch", lineItemId: "li-vn" }),
      ],
      entry(lines),
      [rule("r1", { alertTypes: ["rate_mismatch"], htsPrefix: "8501.31" })],
    );
    expect(keys(htsOut.kept)).toEqual(["vn"]);
  });

  it("scope fields AND together", () => {
    const lines = [
      line({ id: "li-1", supplierName: "Acme", countryOfOrigin: "CN" }),
      line({ id: "li-2", supplierName: "Acme", countryOfOrigin: "VN" }),
    ];
    const out = applySuppressions(
      [
        alert({ alertKey: "a1", alertType: "missing_measure", lineItemId: "li-1" }),
        alert({ alertKey: "a2", alertType: "missing_measure", lineItemId: "li-2" }),
      ],
      entry(lines),
      [
        rule("r1", {
          alertTypes: ["missing_measure"],
          supplierName: "Acme",
          countryOfOrigin: "CN",
        }),
      ],
    );
    expect(keys(out.kept)).toEqual(["a2"]);
  });

  it("scoped rules never suppress entry-level alerts", () => {
    const out = applySuppressions(
      [alert({ alertKey: "vm:entry", alertType: "value_mismatch" })],
      entry([line({ id: "li-1", countryOfOrigin: "CN" })]),
      [rule("r1", { alertTypes: ["value_mismatch"], countryOfOrigin: "CN" })],
    );
    expect(keys(out.kept)).toEqual(["vm:entry"]);
  });

  it("first matching rule wins for attribution; kept ∪ suppressed partitions", () => {
    const alerts = [
      alert({ alertKey: "a1", alertType: "missing_measure", lineItemId: "li-1" }),
      alert({ alertKey: "a2", alertType: "rate_mismatch", lineItemId: "li-1" }),
    ];
    const out = applySuppressions(alerts, entry([line({ id: "li-1" })]), [
      rule("first", { alertTypes: ["missing_measure"] }),
      rule("second", { alertTypes: ["missing_measure", "rate_mismatch"] }),
    ]);
    expect(out.suppressed).toEqual([
      expect.objectContaining({ ruleId: "first", ruleText: "rule first" }),
      expect.objectContaining({ ruleId: "second" }),
    ]);
    expect(out.kept).toEqual([]);
    expect(out.kept.length + out.suppressed.length).toBe(alerts.length);
  });

  it("a rate_mismatch-only spec strands the amount_mismatch twin (documented)", () => {
    const out = applySuppressions(
      [
        alert({ alertKey: "rm:1", alertType: "rate_mismatch", lineItemId: "li-1" }),
        alert({ alertKey: "am:1", alertType: "amount_mismatch", lineItemId: "li-1" }),
      ],
      entry([line({ id: "li-1" })]),
      [rule("r1", { alertTypes: ["rate_mismatch"] })],
    );
    expect(keys(out.kept)).toEqual(["am:1"]);
  });
});
