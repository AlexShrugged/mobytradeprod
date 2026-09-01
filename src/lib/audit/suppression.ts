// Pure org-rule suppression: partition the auditor's desired alerts into
// kept and suppressed under an org's active suppression rules. No DB, no IO
// — the auditor reconciles against `kept`, so suppressed alerts behave
// exactly like disappeared conditions (open rows delete as stale;
// resolved/dismissed rows are never touched; disabling a rule re-inserts on
// the next sweep). Suppression never changes duty math or expected-charge
// displays — it narrows alerting only, the same doctrine as exemption
// linkage.
//
// Matching is deterministic and fails closed: a missing fact keeps the
// alert. Scope fields AND together; entry-level alerts (lineItemId null)
// are suppressed only by unscoped rules — a scoped rule cannot claim an
// alert that has no line to match against.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import { normalizeHtsPrefix, type SuppressionSpec } from "../org-rules";
import type { AuditableEntry, AuditableLine, DesiredAlert } from "./rules";

export type SuppressionRule = {
  id: string;
  text: string;
  suppression: SuppressionSpec;
};

export type SuppressionOutcome = {
  kept: DesiredAlert[];
  suppressed: { alert: DesiredAlert; ruleId: string; ruleText: string }[];
};

const casefold = (s: string) => s.trim().toLowerCase();

/** No scope axes at all — the rule claims its alert types org-wide.
 *  Exported for the analysis queue's blast-radius math. */
export const isUnscoped = (spec: SuppressionSpec): boolean =>
  spec.supplierName === null &&
  spec.countryOfOrigin === null &&
  spec.htsPrefix === null;

/** The line facts the scope axes read — a structural subset of
 *  AuditableLine, so entry_line_items rows qualify directly. */
export type ScopeFacts = {
  supplierName?: string | null;
  countryOfOrigin: string | null;
  htsCodeDigits: string;
};

/** Exported alongside isUnscoped: the analysis queue scopes re-analysis to
 *  entries with a matching line using the SAME axis semantics the auditor
 *  suppresses with, so the two layers can never disagree on scope. */
export function lineMatchesScope(line: ScopeFacts, spec: SuppressionSpec): boolean {
  if (spec.supplierName !== null) {
    if (!line.supplierName) return false;
    if (casefold(line.supplierName) !== casefold(spec.supplierName)) return false;
  }
  if (spec.countryOfOrigin !== null) {
    if (!line.countryOfOrigin) return false;
    if (line.countryOfOrigin.toUpperCase() !== spec.countryOfOrigin.toUpperCase())
      return false;
  }
  if (spec.htsPrefix !== null) {
    if (!line.htsCodeDigits.startsWith(normalizeHtsPrefix(spec.htsPrefix)))
      return false;
  }
  return true;
}

function ruleSuppresses(
  alert: DesiredAlert,
  line: AuditableLine | undefined,
  spec: SuppressionSpec,
): boolean {
  if (!spec.alertTypes.includes(alert.alertType)) return false;
  if (isUnscoped(spec)) return true;
  if (!line) return false; // entry-level alert vs scoped rule: fails closed
  return lineMatchesScope(line, spec);
}

/** First matching rule wins for attribution; order of `kept` is preserved
 *  and `kept ∪ suppressed` partitions the input. */
export function applySuppressions(
  alerts: DesiredAlert[],
  entry: AuditableEntry,
  rules: SuppressionRule[],
): SuppressionOutcome {
  if (rules.length === 0) return { kept: alerts, suppressed: [] };
  const linesById = new Map(entry.lines.map((l) => [l.id, l]));
  const kept: DesiredAlert[] = [];
  const suppressed: SuppressionOutcome["suppressed"] = [];
  for (const alert of alerts) {
    const line = alert.lineItemId
      ? linesById.get(alert.lineItemId)
      : undefined;
    const match = rules.find((r) => ruleSuppresses(alert, line, r.suppression));
    if (match) {
      suppressed.push({ alert, ruleId: match.id, ruleText: match.text });
    } else {
      kept.push(alert);
    }
  }
  return { kept, suppressed };
}
