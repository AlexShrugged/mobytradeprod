// Deterministic analyst: re-expresses the deterministic audit rules' output
// as findings, nothing more. Serves local no-key runs, unit tests, and the
// degraded path of a failed Claude run — and doubles as the eval baseline
// (100% deterministic recall, 0% on planted long-tail defects, by
// construction).
//
// Relative imports on purpose — this module runs under the tsx eval script.

import { computeEntryAlerts, type DesiredAlert } from "../audit/rules";
import type { ReferenceData } from "../duty/types";
import type { Finding, FindingCategory } from "./findings";
import type { AnalystResult, EntryAnalyst, EntryBundle } from "./types";

const CATEGORY_BY_ALERT_TYPE: Record<string, FindingCategory> = {
  missing_measure: "duty_calculation",
  unexpected_measure: "duty_calculation",
  rate_mismatch: "duty_calculation",
  amount_mismatch: "duty_calculation",
  hts_discrepancy: "classification_mismatch",
  hts_reclassified: "classification_mismatch",
  invoice_hts_mismatch: "classification_mismatch",
  coo_discrepancy: "coo_inconsistency",
  value_mismatch: "valuation_concern",
  quantity_discrepancy: "valuation_concern",
  invoice_sku_missing: "valuation_concern",
};

function lineNumberOf(alert: DesiredAlert): number | null {
  const fromDetails = alert.details?.line_number;
  if (typeof fromDetails === "number") return fromDetails;
  const m = /(?:^|:)line(\d+)(?::|$)/.exec(alert.alertKey);
  return m ? Number(m[1]) : null;
}

export function alertToFinding(alert: DesiredAlert): Finding {
  return {
    category: CATEGORY_BY_ALERT_TYPE[alert.alertType] ?? "document_inconsistency",
    severity: alert.severity,
    title: alert.label,
    explanation: alert.message,
    lineNumber: lineNumberOf(alert),
    evidence: [
      {
        source: "calculation",
        documentId: null,
        field: alert.alertKey,
        quote: alert.message,
      },
    ],
    suggestedAction: "Review the deterministic audit finding.",
    confidence: 1,
    relatedAlertKeys: [alert.alertKey],
  };
}

export class StubEntryAnalyst implements EntryAnalyst {
  async analyze(
    bundle: EntryBundle,
    ref: ReferenceData,
  ): Promise<AnalystResult> {
    const findings = computeEntryAlerts(bundle.snapshot.auditable, ref).map(
      alertToFinding,
    );
    return {
      report: {
        summary:
          findings.length === 0
            ? "No deterministic findings. (Stub analyst — no AI analysis ran.)"
            : `${findings.length} deterministic finding(s) re-expressed. (Stub analyst — no AI analysis ran.)`,
        findings,
      },
      usage: {
        iterations: 0,
        inputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
      },
      trace: [],
      analyst: "stub",
      error: null,
    };
  }
}
