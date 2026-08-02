// Pure audit rule evaluation: (entry snapshot, reference data) -> desired
// alerts. No DB, no IO. The auditor persists the result; tests call this
// directly. Money is compared in integer cents; tolerances and the severity
// ladder are legacy-verified values.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import { computeExpectedCharges } from "../duty/calculator";
import type { ReferenceData, SailBasis, SailInfo } from "../duty/types";
import type {
  AuditAlertTypeValue,
  AuditSeverityValue,
  ChargeTypeValue,
} from "../db/schema";

export type AuditableCharge = {
  id: string;
  chargeType: ChargeTypeValue;
  htsCode: string | null;
  htsCodeDigits: string | null;
  rate: string | null;
  amount: string;
};

export type AuditableLine = {
  id: string;
  lineNumber: number;
  sku: string | null;
  htsCode: string;
  htsCodeDigits: string;
  countryOfOrigin: string | null;
  enteredValue: string;
  /** Catalog HTS when the line matched a part; null otherwise. */
  partHtsCode: string | null;
  charges: AuditableCharge[];
};

export type AuditableInvoice = {
  invoiceNumber: string;
  totalAmount: string | null;
  /** Sum of invoice line totals, precomputed by the loader. */
  lineTotalSum: string;
  lineCount: number;
};

export type AuditableEntry = {
  entryDate: string | null;
  totalEnteredValue: string | null;
  totalDuty: string | null;
  /** Resolved sail window of the linked shipments (resolveSailInfo);
   *  null = the loader had no shipment data. */
  sail: SailInfo | null;
  lines: AuditableLine[];
  linkedPos: { poNumber: string; totalAmount: string | null }[];
  /** Invoices reached through this entry's POs. */
  linkedInvoices: AuditableInvoice[];
};

export type DesiredAlert = {
  alertKey: string;
  alertType: AuditAlertTypeValue;
  severity: AuditSeverityValue;
  label: string;
  message: string;
  details: Record<string, unknown> | null;
  lineItemId: string | null;
};

export type AuditConfig = {
  /** Charge amount tolerance: max(absCents, pct of entered value). */
  amountToleranceAbsCents: number;
  amountTolerancePct: number;
  /** Entry-value tolerance: max(absCents, pct of header). */
  valueToleranceAbsCents: number;
  valueTolerancePct: number;
  /** Trust gate: max(absCents, pct of header total duty). */
  trustGateAbsCents: number;
  trustGatePct: number;
  /** PO totals differ in scope from entry values — be generous. */
  poVarianceTolerancePct: number;
  /** Invoices share the PO scope problem — same generosity. */
  invoiceVarianceTolerancePct: number;
};

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  amountToleranceAbsCents: 2,
  amountTolerancePct: 0.01,
  valueToleranceAbsCents: 100,
  valueTolerancePct: 0.01,
  trustGateAbsCents: 200,
  trustGatePct: 0.01,
  poVarianceTolerancePct: 0.1,
  invoiceVarianceTolerancePct: 0.1,
};

const DUTY_CHARGE_TYPES: ReadonlySet<ChargeTypeValue> = new Set([
  "base_duty",
  "additional_duty",
  "antidumping",
  "countervailing",
]);
const ADDITIONAL_CHARGE_TYPES: ReadonlySet<ChargeTypeValue> = new Set([
  "additional_duty",
  "antidumping",
  "countervailing",
]);

const toCents = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);
const dollars = (cents: number) => cents / 100;
const fmt = (cents: number) =>
  `$${Math.abs(dollars(cents)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const pctLabel = (rate: number) => `${Math.round(rate * 10000) / 100}%`;

/** error > $50 or > 10%; warning > $5 or > 2%; else info. */
function moneySeverity(diffCents: number, baseCents: number): AuditSeverityValue {
  const abs = Math.abs(diffCents);
  const pct = baseCents > 0 ? abs / baseCents : 0;
  if (abs > 50_00 || pct > 0.1) return "error";
  if (abs > 5_00 || pct > 0.02) return "warning";
  return "info";
}

export function computeEntryAlerts(
  entry: AuditableEntry,
  ref: ReferenceData,
  config: AuditConfig = DEFAULT_AUDIT_CONFIG,
): DesiredAlert[] {
  const alerts: DesiredAlert[] = [];

  // ---- Rule 5: HTS vs catalog (runs regardless of the trust gate) --------
  const htsDiscrepancyLines = new Set<string>();
  for (const line of entry.lines) {
    if (!line.partHtsCode) continue;
    const catalogDigits = line.partHtsCode.replace(/\D/g, "");
    if (catalogDigits === line.htsCodeDigits) continue;
    htsDiscrepancyLines.add(line.id);
    const firstSixAgree =
      catalogDigits.slice(0, 6) === line.htsCodeDigits.slice(0, 6);
    alerts.push({
      alertKey: `hts_discrepancy:line${line.lineNumber}`,
      alertType: "hts_discrepancy",
      severity: firstSixAgree ? "info" : "warning",
      label: "HTS differs from catalog",
      message: `Line ${line.lineNumber} (${line.sku ?? "no SKU"}) is declared as ${line.htsCode}, but the catalog classifies this part as ${line.partHtsCode}.`,
      details: {
        expected_hts: line.partHtsCode,
        actual_hts: line.htsCode,
        line_number: line.lineNumber,
        sku: line.sku,
      },
      lineItemId: line.id,
    });
  }

  // ---- Rule 0: trust gate ------------------------------------------------
  // If the ingested duty charges cannot be reconciled with the header total,
  // every per-charge compliance finding would be noise — suspend rules 1-4
  // and say so once.
  const headerDutyCents = toCents(entry.totalDuty);
  let chargesTrusted = true;
  if (headerDutyCents !== null && entry.lines.some((l) => l.charges.length)) {
    let declaredDutyCents = 0;
    for (const line of entry.lines) {
      for (const c of line.charges) {
        if (DUTY_CHARGE_TYPES.has(c.chargeType)) {
          declaredDutyCents += toCents(c.amount) ?? 0;
        }
      }
    }
    const diff = Math.abs(declaredDutyCents - headerDutyCents);
    const tolerance = Math.max(
      config.trustGateAbsCents,
      Math.round(headerDutyCents * config.trustGatePct),
    );
    if (diff > tolerance) {
      chargesTrusted = false;
      alerts.push({
        alertKey: "unreconciled:duty_total",
        alertType: "data_unreconciled",
        severity: "info",
        label: "Charge data unreconciled",
        message: `Line-level duty charges total ${fmt(declaredDutyCents)}, but the entry header reports ${fmt(headerDutyCents)}. Compliance checks are suspended until the charge data reconciles.`,
        details: {
          expected_amount: dollars(headerDutyCents),
          actual_amount: dollars(declaredDutyCents),
          difference_amount: dollars(diff),
        },
        lineItemId: null,
      });
    }
  }

  // ---- Rules 1-4: per-line measure and money checks ----------------------
  if (chargesTrusted && entry.entryDate) {
    // Worst grounding of any line's sail-conditioned expectations:
    // assumed > estimated > exact/none. Feeds the entry-level Rule 5 alert.
    let worstSailBasis: SailBasis = null;
    const sailAffectedLines = new Set<number>();

    for (const line of entry.lines) {
      // No charges at all is an ingestion gap, not a compliance finding;
      // without a country of origin the expected-measure set is unreliable.
      if (line.charges.length === 0 || !line.countryOfOrigin) continue;

      const enteredCents = toCents(line.enteredValue) ?? 0;
      const expected = computeExpectedCharges(
        {
          htsDigits: line.htsCodeDigits,
          countryOfOrigin: line.countryOfOrigin,
          enteredValueCents: enteredCents,
          entryDate: entry.entryDate,
          sail: entry.sail,
        },
        ref,
      );
      if (expected.sailBasis === "estimated" || expected.sailBasis === "assumed") {
        sailAffectedLines.add(line.lineNumber);
        if (worstSailBasis !== "assumed") worstSailBasis = expected.sailBasis;
      }

      const declaredAdditional = line.charges.filter((c) =>
        ADDITIONAL_CHARGE_TYPES.has(c.chargeType),
      );
      const declaredDigits = new Set(
        line.charges.map((c) => c.htsCodeDigits).filter(Boolean),
      );
      const applicableAuthorities = new Set(
        expected.measures.map((m) => m.authority),
      );

      // Rule 1: expected measure with no matching charge. A declared
      // exclusion code ($0 claim) satisfies its parent measure.
      for (const m of expected.measures) {
        const satisfied =
          declaredDigits.has(m.ch99Digits) ||
          m.exclusionDigits.some((d) => declaredDigits.has(d));
        if (satisfied) continue;
        alerts.push({
          alertKey: `missing_measure:line${line.lineNumber}:${m.ch99Digits}`,
          alertType: "missing_measure",
          severity: "warning",
          label: `Missing ${m.name}`,
          message: `Line ${line.lineNumber} (${line.htsCode}, ${line.countryOfOrigin}) should carry ${m.name} (${m.ch99Code}) at ${pctLabel(m.rate)} — expected ${fmt(m.amountCents)} — but no such charge was declared.`,
          details: {
            measure_name: m.name,
            authority: m.authority,
            expected_hts: m.ch99Code,
            expected_rate: m.rate,
            expected_amount: dollars(m.amountCents),
            line_number: line.lineNumber,
            sku: line.sku,
          },
          lineItemId: line.id,
        });
      }

      // Rule 1b: dutiable schedule rate with no base duty charge.
      const hasBaseCharge = line.charges.some(
        (c) => c.chargeType === "base_duty",
      );
      if (
        !hasBaseCharge &&
        expected.baseDuty !== null &&
        expected.baseDuty.rate !== null &&
        expected.baseDuty.rate > 0 &&
        expected.baseDuty.amountCents !== null &&
        expected.baseDuty.amountCents > 0
      ) {
        alerts.push({
          alertKey: `missing_base_duty:line${line.lineNumber}`,
          alertType: "missing_measure",
          severity: "warning",
          label: "Missing base duty",
          message: `Line ${line.lineNumber} (${line.htsCode}) has a ${pctLabel(expected.baseDuty.rate)} general rate — expected ${fmt(expected.baseDuty.amountCents)} — but no base duty charge was declared.`,
          details: {
            expected_rate: expected.baseDuty.rate,
            expected_amount: dollars(expected.baseDuty.amountCents),
            line_number: line.lineNumber,
            sku: line.sku,
          },
          lineItemId: line.id,
        });
      }

      // Rule 2: declared additional-duty charge we did not expect.
      for (const c of declaredAdditional) {
        const amountCents = toCents(c.amount) ?? 0;
        if (amountCents === 0) continue; // exclusion claimed — a statement
        if (!c.htsCodeDigits) continue;
        if (declaredMatchesExpected(c.htsCodeDigits, expected.measures)) continue;

        const refRow = ref.htsByDigits.get(c.htsCodeDigits);
        if (refRow?.exemption) continue; // exclusion codes are always allowed
        // Chapter 99 digits may back several measure windows; prefer the
        // one active on the entry date, fall back to any (display only).
        const refMeasure =
          ref.measures.find(
            (m) =>
              m.ch99Digits === c.htsCodeDigits &&
              m.effectiveDate <= entry.entryDate! &&
              (m.endDate === null || entry.entryDate! <= m.endDate),
          ) ?? ref.measures.find((m) => m.ch99Digits === c.htsCodeDigits);
        // Same authority already expected under a different list: not a
        // finding we can adjudicate at this granularity.
        if (refMeasure && applicableAuthorities.has(refMeasure.authority)) {
          continue;
        }

        const suppressedMatch = expected.suppressed.find(
          (s) => s.ch99Digits === c.htsCodeDigits,
        );
        const name =
          suppressedMatch?.name ?? refMeasure?.name ?? c.htsCode ?? "measure";
        alerts.push({
          alertKey: `unexpected_measure:line${line.lineNumber}:${c.htsCodeDigits}`,
          alertType: "unexpected_measure",
          severity: suppressedMatch ? "warning" : "info",
          label: `Unexpected ${name}`,
          message: suppressedMatch
            ? `Line ${line.lineNumber} declares ${name} (${c.htsCode}) for ${fmt(amountCents)}, but it should not apply: ${suppressedMatch.suppressedBy.reason}`
            : `Line ${line.lineNumber} declares ${name} (${c.htsCode}) for ${fmt(amountCents)}, which our reference data does not show applying to ${line.htsCode} from ${line.countryOfOrigin}. This may be a coverage gap — review before acting.`,
          details: {
            measure_name: name,
            actual_hts: c.htsCode,
            actual_amount: dollars(amountCents),
            line_number: line.lineNumber,
            sku: line.sku,
            ...(suppressedMatch
              ? { stacking_reason: suppressedMatch.suppressedBy.reason }
              : {}),
          },
          lineItemId: line.id,
        });
      }

      // Rules 3 & 4: rate/amount vs expectation. Classification doubt
      // poisons the money math, so skip lines with an HTS discrepancy.
      if (htsDiscrepancyLines.has(line.id)) continue;

      for (const c of line.charges) {
        const amountCents = toCents(c.amount) ?? 0;
        let expectedRate: number | null = null;
        let expectedAmountCents: number | null = null;
        let chargeRefKey: string | null = null;

        if (c.chargeType === "base_duty") {
          if (
            expected.baseDuty?.rate != null &&
            expected.baseDuty.amountCents !== null
          ) {
            expectedRate = expected.baseDuty.rate;
            expectedAmountCents = expected.baseDuty.amountCents;
            chargeRefKey = "base";
          }
        } else if (
          ADDITIONAL_CHARGE_TYPES.has(c.chargeType) &&
          c.htsCodeDigits
        ) {
          const m = expected.measures.find(
            (em) => em.ch99Digits === c.htsCodeDigits,
          );
          if (m) {
            expectedRate = m.rate;
            expectedAmountCents = m.amountCents;
            chargeRefKey = c.htsCodeDigits;
          }
        }
        if (expectedRate === null || expectedAmountCents === null || !chargeRefKey)
          continue;

        // Rule 3: declared rate deviates from the official rate.
        const declaredRate = c.rate === null ? null : Number(c.rate);
        if (declaredRate !== null && Math.abs(declaredRate - expectedRate) > 0.00005) {
          const impliedDiff = Math.round(
            Math.abs(declaredRate - expectedRate) * enteredCents,
          );
          alerts.push({
            alertKey: `rate_mismatch:line${line.lineNumber}:${chargeRefKey}`,
            alertType: "rate_mismatch",
            severity: moneySeverity(impliedDiff, expectedAmountCents),
            label: "Rate mismatch",
            message: `Line ${line.lineNumber} ${c.htsCode ?? "base duty"} is declared at ${pctLabel(declaredRate)}; the official rate is ${pctLabel(expectedRate)}.`,
            details: {
              expected_rate: expectedRate,
              actual_rate: declaredRate,
              charge_type: c.chargeType,
              line_number: line.lineNumber,
              sku: line.sku,
            },
            lineItemId: line.id,
          });
        }

        // Rule 4: declared amount deviates from rate x entered value.
        // $0 is an exclusion claim, never an underpayment.
        if (amountCents === 0) continue;
        const diff = Math.abs(amountCents - expectedAmountCents);
        const tolerance = Math.max(
          config.amountToleranceAbsCents,
          Math.round(enteredCents * config.amountTolerancePct),
        );
        if (diff > tolerance) {
          alerts.push({
            alertKey: `amount_mismatch:line${line.lineNumber}:${chargeRefKey}`,
            alertType: "amount_mismatch",
            severity: moneySeverity(diff, expectedAmountCents),
            label: "Duty amount mismatch",
            message: `Line ${line.lineNumber} ${c.htsCode ?? "base duty"} was charged ${fmt(amountCents)}; ${pctLabel(expectedRate)} of the ${fmt(enteredCents)} entered value is ${fmt(expectedAmountCents)} (${amountCents > expectedAmountCents ? "overpaid" : "underpaid"} ${fmt(diff)}).`,
            details: {
              expected_amount: dollars(expectedAmountCents),
              actual_amount: dollars(amountCents),
              difference_amount: dollars(diff),
              difference_pct:
                expectedAmountCents > 0
                  ? Math.round((diff / expectedAmountCents) * 10000) / 100
                  : null,
              charge_type: c.chargeType,
              line_number: line.lineNumber,
              sku: line.sku,
            },
            lineItemId: line.id,
          });
        }
      }
    }

    // ---- Rule 5: sail-conditioned expectations rest on an assumption -----
    // One entry-level info alert, not one per line: the grounding (which
    // sail date we trusted) is an entry-wide fact.
    if (worstSailBasis === "estimated" || worstSailBasis === "assumed") {
      const basisLabel =
        worstSailBasis === "estimated"
          ? "an ETD-estimated sail date"
          : "no usable sail date";
      alerts.push({
        alertKey: "sail_assumption:entry",
        alertType: "sail_date_assumption",
        severity: "info",
        label: "Sail date assumed",
        message: `Sail-conditioned tariff expectations on line(s) ${[...sailAffectedLines].sort((a, b) => a - b).join(", ")} were computed from ${basisLabel}. Confirm the on-board date from the bill of lading — the applicable measure set may change.`,
        details: {
          sail_basis: worstSailBasis,
          line_numbers: [...sailAffectedLines].sort((a, b) => a - b),
          earliest_sail: entry.sail?.earliestSail ?? null,
          latest_sail: entry.sail?.latestSail ?? null,
        },
        lineItemId: null,
      });
    }
  }

  // ---- Rule 6: header entered value vs line sum --------------------------
  const headerValueCents = toCents(entry.totalEnteredValue);
  if (headerValueCents !== null && entry.lines.length > 0) {
    let lineSumCents = 0;
    for (const line of entry.lines) lineSumCents += toCents(line.enteredValue) ?? 0;
    const diff = Math.abs(lineSumCents - headerValueCents);
    const tolerance = Math.max(
      config.valueToleranceAbsCents,
      Math.round(headerValueCents * config.valueTolerancePct),
    );
    if (diff > tolerance) {
      alerts.push({
        alertKey: "value_mismatch:entered_value",
        alertType: "value_mismatch",
        severity: moneySeverity(diff, headerValueCents),
        label: "Entered value mismatch",
        message: `Line items total ${fmt(lineSumCents)}, but the entry header reports ${fmt(headerValueCents)} entered value.`,
        details: {
          expected_amount: dollars(headerValueCents),
          actual_amount: dollars(lineSumCents),
          difference_amount: dollars(diff),
        },
        lineItemId: null,
      });
    }
  }

  // ---- Rule 7: PO totals vs entered value (info only — PO scope is not
  // entry scope, so this is a prompt to look, not a finding) ---------------
  if (
    headerValueCents !== null &&
    entry.linkedPos.length > 0 &&
    entry.linkedPos.every((po) => po.totalAmount !== null)
  ) {
    let poSumCents = 0;
    for (const po of entry.linkedPos) poSumCents += toCents(po.totalAmount) ?? 0;
    const diff = Math.abs(poSumCents - headerValueCents);
    if (poSumCents > 0 && diff > Math.round(poSumCents * config.poVarianceTolerancePct)) {
      alerts.push({
        alertKey: "value_mismatch:po_total",
        alertType: "value_mismatch",
        severity: "info",
        label: "PO total variance",
        message: `The ${entry.linkedPos.length} linked purchase order(s) total ${fmt(poSumCents)}, vs ${fmt(headerValueCents)} entered on this entry. POs can span multiple entries, so this is informational.`,
        details: {
          expected_amount: dollars(poSumCents),
          actual_amount: dollars(headerValueCents),
          difference_amount: dollars(diff),
        },
        lineItemId: null,
      });
    }
  }

  // ---- Rule 8: invoice internal consistency (header vs line sum) ---------
  // An invoice whose own lines don't add up poisons any entry-vs-invoice
  // comparison, so it is flagged per invoice, before rule 9.
  const consistentInvoices: AuditableInvoice[] = [];
  for (const inv of entry.linkedInvoices) {
    const headerCents = toCents(inv.totalAmount);
    if (headerCents === null || inv.lineCount === 0) {
      if (headerCents !== null) consistentInvoices.push(inv);
      continue;
    }
    const lineSumCents = toCents(inv.lineTotalSum) ?? 0;
    const diff = Math.abs(lineSumCents - headerCents);
    const tolerance = Math.max(
      config.valueToleranceAbsCents,
      Math.round(headerCents * config.valueTolerancePct),
    );
    if (diff > tolerance) {
      alerts.push({
        alertKey: `value_mismatch:invoice:${inv.invoiceNumber}`,
        alertType: "value_mismatch",
        severity: moneySeverity(diff, headerCents),
        label: "Invoice total mismatch",
        message: `Invoice ${inv.invoiceNumber} reports ${fmt(headerCents)}, but its ${inv.lineCount} line(s) total ${fmt(lineSumCents)}.`,
        details: {
          invoice_number: inv.invoiceNumber,
          expected_amount: dollars(headerCents),
          actual_amount: dollars(lineSumCents),
          difference_amount: dollars(diff),
        },
        lineItemId: null,
      });
    } else {
      consistentInvoices.push(inv);
    }
  }

  // ---- Rule 9: invoice totals vs entered value (info only — invoices
  // share the PO scope problem, so this is a prompt to look) ---------------
  if (
    headerValueCents !== null &&
    consistentInvoices.length > 0 &&
    consistentInvoices.length === entry.linkedInvoices.length
  ) {
    let invSumCents = 0;
    for (const inv of consistentInvoices) invSumCents += toCents(inv.totalAmount) ?? 0;
    const diff = Math.abs(invSumCents - headerValueCents);
    if (
      invSumCents > 0 &&
      diff > Math.round(invSumCents * config.invoiceVarianceTolerancePct)
    ) {
      alerts.push({
        alertKey: "value_mismatch:invoice_total",
        alertType: "value_mismatch",
        severity: "info",
        label: "Invoice total variance",
        message: `The ${consistentInvoices.length} linked commercial invoice(s) total ${fmt(invSumCents)}, vs ${fmt(headerValueCents)} entered on this entry. Invoices attach via POs and can span multiple entries, so this is informational.`,
        details: {
          expected_amount: dollars(invSumCents),
          actual_amount: dollars(headerValueCents),
          difference_amount: dollars(diff),
        },
        lineItemId: null,
      });
    }
  }

  return alerts;
}

function declaredMatchesExpected(
  digits: string,
  measures: { ch99Digits: string }[],
): boolean {
  return measures.some((m) => m.ch99Digits === digits);
}
