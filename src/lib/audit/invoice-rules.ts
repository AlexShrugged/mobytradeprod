// CI-vs-entry document comparison rules (rules 8–15): the commercial
// invoice is the PRIMARY document an entry is checked against for variance
// — HTS, value, quantity, origin. Pure: no DB, no IO; called from
// computeEntryAlerts so the auditor/tests entry point is unchanged.
//
// Design carried from the legacy platform's auditor (settled 2026-08-06):
//   - SKU-GROUPED, pairing-invariant comparisons — per-line pairing was
//     retired there for false positives (shuffled/partial line links
//     flagged documents that actually agreed). Sums per SKU cannot be
//     fooled by how lines happen to pair up.
//   - Applicability gate: an invoice must map to exactly ONE entry
//     (linkedEntryCount === 1). An invoice spanning entries is normal
//     consolidation — skipped silently, surfaced as context on the entry
//     page, never a finding.
//   - Per-SKU value deltas only fire when the header total ALSO fails —
//     without a header failure they are distribution noise.
//   - No FX support: money checks gate on currency === USD with an info
//     notice, instead of fabricating variance from a EUR invoice.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import type {
  AuditableEntry,
  AuditableInvoice,
  AuditableLine,
  AuditConfig,
  DesiredAlert,
} from "./rules";
import { dollars, fmt, moneySeverity, toCents } from "./rules";

const DUTY_RATE_CHARGE_TYPES = new Set([
  "base_duty",
  "additional_duty",
  "antidumping",
  "countervailing",
]);

// The extraction sentinel for "no SKU found" — never a real part number.
const SKU_SENTINEL = "NOT_FOUND";

const normalizeSku = (sku: string | null): string | null => {
  const s = sku?.trim().toUpperCase() ?? null;
  return s && s !== SKU_SENTINEL ? s : null;
};

// Value-weighted ad-valorem duty rate over a set of entry lines, from the
// DECLARED duty charges (decimal fractions; MPF/HMF excluded — capped fees,
// not ad valorem in effect). This is what a $1 of entered-value variance is
// worth in duty. Null when no line carries a rated duty charge — impact.ts
// treats its presence in details as "this alert grounds a dollar claim".
function effectiveAdValoremRate(lines: AuditableLine[]): number | null {
  let weightedRate = 0; // Σ enteredCents × lineRateSum
  let totalCents = 0;
  let anyRated = false;
  for (const line of lines) {
    const enteredCents = toCents(line.enteredValue) ?? 0;
    totalCents += enteredCents;
    let lineRate = 0;
    for (const c of line.charges) {
      if (DUTY_RATE_CHARGE_TYPES.has(c.chargeType) && c.rate !== null) {
        lineRate += Number(c.rate);
        anyRated = true;
      }
    }
    weightedRate += enteredCents * lineRate;
  }
  if (!anyRated || totalCents <= 0) return null;
  return Math.round((weightedRate / totalCents) * 1_000_000) / 1_000_000;
}

// Per-SKU aggregation of one side. quantity is null when any contributing
// line omits it — a partial sum would fabricate a shortfall.
type SkuAgg = {
  valueCents: number;
  quantity: number | null;
  quantitySeen: boolean;
  htsDigits: string[]; // sorted unique
  htsDisplay: string[]; // as printed, sorted unique
  coos: string[]; // sorted unique
};

function newAgg(): SkuAgg {
  return {
    valueCents: 0,
    quantity: 0,
    quantitySeen: false,
    htsDigits: [],
    htsDisplay: [],
    coos: [],
  };
}

function addUnique(list: string[], value: string) {
  if (!list.includes(value)) {
    list.push(value);
    list.sort();
  }
}

export function computeInvoiceAlerts(
  entry: AuditableEntry,
  config: AuditConfig,
): DesiredAlert[] {
  const alerts: DesiredAlert[] = [];
  if (entry.linkedInvoices.length === 0) return alerts;

  // ---- Rule 8: invoice internal consistency (header vs own line sum) -----
  // An invoice whose own lines don't add up poisons every entry-vs-invoice
  // comparison. Runs for every linked invoice regardless of currency —
  // internal consistency is currency-agnostic.
  const consistent = new Map<AuditableInvoice, boolean>();
  for (const inv of entry.linkedInvoices) {
    const headerCents = toCents(inv.totalAmount);
    if (headerCents === null || inv.lines.length === 0) {
      // Nothing to cross-check — not evidence of inconsistency.
      consistent.set(inv, true);
      continue;
    }
    let lineSumCents = 0;
    for (const line of inv.lines) lineSumCents += toCents(line.totalPrice) ?? 0;
    const diff = Math.abs(lineSumCents - headerCents);
    const tolerance = Math.max(
      config.valueToleranceAbsCents,
      Math.round(headerCents * config.valueTolerancePct),
    );
    if (diff > tolerance) {
      consistent.set(inv, false);
      alerts.push({
        alertKey: `value_mismatch:invoice:${inv.invoiceNumber}`,
        alertType: "value_mismatch",
        severity: moneySeverity(diff, headerCents),
        label: "Invoice total mismatch",
        message: `Invoice ${inv.invoiceNumber} reports ${fmt(headerCents)}, but its ${inv.lines.length} line(s) total ${fmt(lineSumCents)}.`,
        details: {
          invoice_number: inv.invoiceNumber,
          expected_amount: dollars(headerCents),
          actual_amount: dollars(lineSumCents),
          difference_amount: dollars(diff),
        },
        lineItemId: null,
      });
    } else {
      consistent.set(inv, true);
    }
  }

  // Per-invoice eligibility. singleEntry failures skip SILENTLY (normal
  // consolidation); non-USD gets an info notice (rule 9b) because it is a
  // fixable data-quality gap, not a business shape.
  const isEligibleDoc = (inv: AuditableInvoice) =>
    (consistent.get(inv) ?? true) && inv.linkedEntryCount === 1;
  const isEligibleMoney = (inv: AuditableInvoice) =>
    isEligibleDoc(inv) && inv.currency === "USD";

  // ---- Rule 9b: non-USD notice -------------------------------------------
  for (const inv of entry.linkedInvoices) {
    if (inv.currency !== "USD" && inv.linkedEntryCount === 1) {
      alerts.push({
        alertKey: `invoice_skipped:${inv.invoiceNumber}`,
        alertType: "invoice_comparison_skipped",
        severity: "info",
        label: "Invoice comparison skipped",
        message: `Invoice ${inv.invoiceNumber} is in ${inv.currency}; value and quantity comparison is skipped (no FX support yet). Classification and origin checks still run.`,
        details: {
          invoice_number: inv.invoiceNumber,
          currency: inv.currency,
          reason: "non_usd_currency",
        },
        lineItemId: null,
      });
    }
  }

  // ---- SKU aggregation (both sides) --------------------------------------
  const entryBySku = new Map<string, SkuAgg>();
  const entryLinesBySku = new Map<string, AuditableLine[]>();
  for (const line of entry.lines) {
    const sku = normalizeSku(line.sku);
    if (!sku) continue;
    const agg = entryBySku.get(sku) ?? newAgg();
    agg.valueCents += toCents(line.enteredValue) ?? 0;
    if (line.quantity === null) agg.quantity = null;
    else if (agg.quantity !== null)
      agg.quantity =
        Math.round((agg.quantity + Number(line.quantity)) * 10000) / 10000;
    agg.quantitySeen = true;
    addUnique(agg.htsDigits, line.htsCodeDigits);
    addUnique(agg.htsDisplay, line.htsCode);
    if (line.countryOfOrigin) addUnique(agg.coos, line.countryOfOrigin);
    entryBySku.set(sku, agg);
    const lines = entryLinesBySku.get(sku) ?? [];
    lines.push(line);
    entryLinesBySku.set(sku, lines);
  }

  // CI-side aggregations over two invoice sets: document checks (HTS/COO/
  // presence — any currency) and money checks (USD only).
  const buildCiAgg = (invoices: AuditableInvoice[]) => {
    const bySku = new Map<string, SkuAgg>();
    const invoiceNumbersBySku = new Map<string, string[]>();
    for (const inv of invoices) {
      for (const line of inv.lines) {
        const sku = normalizeSku(line.sku);
        if (!sku) continue;
        const agg = bySku.get(sku) ?? newAgg();
        agg.valueCents += toCents(line.totalPrice) ?? 0;
        if (line.quantity === null) agg.quantity = null;
        else if (agg.quantity !== null)
          agg.quantity =
            Math.round((agg.quantity + Number(line.quantity)) * 10000) / 10000;
        agg.quantitySeen = true;
        // CI codes under 6 digits carry no comparable signal — a chapter or
        // heading prefix cannot ground an HTS variance.
        if (line.htsCodeDigits && line.htsCodeDigits.length >= 6) {
          addUnique(agg.htsDigits, line.htsCodeDigits);
          if (line.htsCode) addUnique(agg.htsDisplay, line.htsCode);
        }
        if (line.countryOfOrigin) addUnique(agg.coos, line.countryOfOrigin);
        bySku.set(sku, agg);
        const nums = invoiceNumbersBySku.get(sku) ?? [];
        addUnique(nums, inv.invoiceNumber);
        invoiceNumbersBySku.set(sku, nums);
      }
    }
    return { bySku, invoiceNumbersBySku };
  };

  const docInvoices = entry.linkedInvoices.filter(isEligibleDoc);
  const moneyInvoices = entry.linkedInvoices.filter(isEligibleMoney);
  const ciDoc = buildCiAgg(docInvoices);
  const ciMoney = buildCiAgg(moneyInvoices);

  // Display metadata for a SKU-scoped alert: the SKU's first entry line
  // anchors it (display only — scope lives in the alertKey).
  const skuLineMeta = (sku: string) => {
    const lines = entryLinesBySku.get(sku) ?? [];
    const numbers = lines.map((l) => l.lineNumber).sort((a, b) => a - b);
    return {
      lineItemId: lines[0]?.id ?? null,
      line_number: numbers[0] ?? null,
      line_numbers: numbers,
    };
  };

  const headerValueCents = toCents(entry.totalEnteredValue);
  const entrySkus = [...entryBySku.keys()].sort();

  // ---- Rule 15: entry SKU missing from the CI ----------------------------
  // Only when at least one eligible CI carries real SKUs — a CI with no
  // usable SKUs at all says nothing about coverage. The converse (a CI SKU
  // absent from the entry — un-entered goods) is deliberately out of scope
  // for now.
  const ciHasRealSkus = ciDoc.bySku.size > 0;
  const uncoveredSkus = new Set<string>();
  if (ciHasRealSkus) {
    const checkedInvoices = docInvoices.map((i) => i.invoiceNumber).sort();
    for (const sku of entrySkus) {
      if (ciDoc.bySku.has(sku)) continue;
      uncoveredSkus.add(sku);
      const meta = skuLineMeta(sku);
      alerts.push({
        alertKey: `invoice_sku_missing:invoice_sku:${sku}`,
        alertType: "invoice_sku_missing",
        severity: "info",
        label: "SKU not on invoice",
        message: `${sku} (line ${meta.line_numbers.join(", ")}) is declared on the entry but appears on none of the linked commercial invoice(s) ${checkedInvoices.join(", ")}.`,
        details: {
          sku,
          invoice_numbers: checkedInvoices,
          line_number: meta.line_number,
          line_numbers: meta.line_numbers,
        },
        lineItemId: meta.lineItemId,
      });
    }
  }

  // ---- Rule 9: CI header value vs entered value --------------------------
  // Real severity — the CI is the document of record for value. Gates:
  // every linked invoice must be money-eligible with a header amount (one
  // bad apple poisons the sum), and every entry line must carry a SKU the
  // CIs cover — incomplete ingestion surfaces as rule 15, not as a fake
  // value variance.
  let rule9Fired = false;
  const allMoneyEligible =
    entry.linkedInvoices.length > 0 &&
    entry.linkedInvoices.every(
      (inv) => isEligibleMoney(inv) && inv.totalAmount !== null,
    );
  const fullCoverage =
    entry.lines.length > 0 &&
    entry.lines.every((l) => normalizeSku(l.sku) !== null) &&
    uncoveredSkus.size === 0 &&
    ciHasRealSkus;
  if (headerValueCents !== null && allMoneyEligible && fullCoverage) {
    let invSumCents = 0;
    for (const inv of entry.linkedInvoices)
      invSumCents += toCents(inv.totalAmount) ?? 0;
    const diff = Math.abs(invSumCents - headerValueCents);
    const tolerance = Math.max(
      config.valueToleranceAbsCents,
      Math.round(invSumCents * config.valueTolerancePct),
    );
    if (invSumCents > 0 && diff > tolerance) {
      rule9Fired = true;
      const invoiceNumbers = entry.linkedInvoices
        .map((i) => i.invoiceNumber)
        .sort();
      const rate = effectiveAdValoremRate(entry.lines);
      alerts.push({
        alertKey: "value_mismatch:invoice_total",
        alertType: "value_mismatch",
        severity: moneySeverity(diff, invSumCents),
        label: "Entered value differs from invoice",
        message: `The linked commercial invoice(s) ${invoiceNumbers.join(", ")} total ${fmt(invSumCents)}, but the entry declares ${fmt(headerValueCents)} entered value (${headerValueCents > invSumCents ? "over" : "under"}-declared by ${fmt(diff)}).`,
        details: {
          expected_amount: dollars(invSumCents),
          actual_amount: dollars(headerValueCents),
          difference_amount: dollars(diff),
          invoice_numbers: invoiceNumbers,
          ...(rate !== null ? { effective_duty_rate: rate } : {}),
        },
        lineItemId: null,
      });
    }
  }

  // ---- Rule 11: SKU-grouped value mismatch -------------------------------
  // Pairing-invariant per-SKU sums; gated on rule 9 firing (per-SKU deltas
  // with a clean header total are distribution noise, not variance).
  if (rule9Fired) {
    for (const sku of entrySkus) {
      const ciAgg = ciMoney.bySku.get(sku);
      if (!ciAgg) continue;
      const entryAgg = entryBySku.get(sku)!;
      const diff = Math.abs(entryAgg.valueCents - ciAgg.valueCents);
      const tolerance = Math.max(
        config.valueToleranceAbsCents,
        Math.round(ciAgg.valueCents * config.valueTolerancePct),
      );
      if (diff <= tolerance) continue;
      const meta = skuLineMeta(sku);
      const rate = effectiveAdValoremRate(entryLinesBySku.get(sku) ?? []);
      alerts.push({
        alertKey: `value_mismatch:invoice_sku:${sku}`,
        alertType: "value_mismatch",
        severity: moneySeverity(diff, ciAgg.valueCents),
        label: "Value differs from invoice",
        message: `${sku} is entered at ${fmt(entryAgg.valueCents)}, but the commercial invoice bills ${fmt(ciAgg.valueCents)} for it (${entryAgg.valueCents > ciAgg.valueCents ? "over" : "under"}-declared by ${fmt(diff)}).`,
        details: {
          sku,
          expected_amount: dollars(ciAgg.valueCents),
          actual_amount: dollars(entryAgg.valueCents),
          difference_amount: dollars(diff),
          invoice_numbers: ciMoney.invoiceNumbersBySku.get(sku) ?? [],
          line_number: meta.line_number,
          line_numbers: meta.line_numbers,
          ...(rate !== null ? { effective_duty_rate: rate } : {}),
        },
        lineItemId: meta.lineItemId,
      });
    }
  }

  // ---- Rule 12: SKU-grouped quantity mismatch ----------------------------
  // Not gated on rule 9 (there is no quantity header), but it needs every
  // linked invoice money-eligible — a skipped invoice's quantities would
  // read as a shortfall. Skips SKUs where either side omits a quantity.
  if (allMoneyEligible) {
    for (const sku of entrySkus) {
      const ciAgg = ciMoney.bySku.get(sku);
      const entryAgg = entryBySku.get(sku)!;
      if (!ciAgg) continue;
      if (
        entryAgg.quantity === null ||
        ciAgg.quantity === null ||
        !entryAgg.quantitySeen ||
        !ciAgg.quantitySeen
      )
        continue;
      // Round before comparing — 4dp quantities summed as floats can carry
      // 1e-15 artifacts that would breach the tolerance boundary.
      const diff =
        Math.round(Math.abs(entryAgg.quantity - ciAgg.quantity) * 10000) /
        10000;
      if (diff <= config.quantityToleranceUnits) continue;
      const meta = skuLineMeta(sku);
      alerts.push({
        alertKey: `quantity_discrepancy:invoice_sku:${sku}`,
        alertType: "quantity_discrepancy",
        severity: "warning",
        label: "Quantity differs from invoice",
        message: `${sku} is entered with quantity ${entryAgg.quantity}, but the commercial invoice bills ${ciAgg.quantity}.`,
        details: {
          sku,
          expected_quantity: ciAgg.quantity,
          actual_quantity: entryAgg.quantity,
          difference_quantity: diff,
          invoice_numbers: ciMoney.invoiceNumbersBySku.get(sku) ?? [],
          line_number: meta.line_number,
          line_numbers: meta.line_numbers,
        },
        lineItemId: meta.lineItemId,
      });
    }
  }

  // ---- Rule 13: per-SKU HTS mismatch (currency-independent) --------------
  // CIs often carry 6/8-digit HS codes: compare on the digits both sides
  // share (min length, ≥6 by construction). Multiple codes per SKU on
  // either side flag only when NO (entry, CI) pair agrees. Severity drops
  // to info when the first 6 digits agree — the same statistical-suffix
  // downgrade rule 5 applies to catalog codes. Unlike rule 5, an HTS
  // mismatch here NEVER suppresses the money rules 3/4: a supplier's
  // printed code is weaker evidence than the org's own catalog.
  for (const sku of entrySkus) {
    const ciAgg = ciDoc.bySku.get(sku);
    const entryAgg = entryBySku.get(sku)!;
    if (!ciAgg || ciAgg.htsDigits.length === 0) continue;
    const pairs: [string, string][] = [];
    for (const e of entryAgg.htsDigits)
      for (const c of ciAgg.htsDigits) pairs.push([e, c]);
    const prefixAgrees = pairs.some(([e, c]) => {
      const n = Math.min(e.length, c.length);
      return n >= 6 && e.slice(0, n) === c.slice(0, n);
    });
    if (prefixAgrees) continue;
    const firstSixAgree = pairs.some(
      ([e, c]) => e.slice(0, 6) === c.slice(0, 6),
    );
    const comparedDigits = Math.min(
      ...pairs.map(([e, c]) => Math.min(e.length, c.length)),
    );
    const meta = skuLineMeta(sku);
    alerts.push({
      alertKey: `invoice_hts_mismatch:invoice_sku:${sku}`,
      alertType: "invoice_hts_mismatch",
      severity: firstSixAgree ? "info" : "warning",
      label: "HTS differs from invoice",
      message: `${sku} is entered under ${entryAgg.htsDisplay.join(", ")}, but the commercial invoice prints ${ciAgg.htsDisplay.join(", ")}.`,
      details: {
        sku,
        expected_hts: ciAgg.htsDisplay[0],
        expected_hts_codes: ciAgg.htsDisplay,
        actual_hts: entryAgg.htsDisplay[0],
        actual_hts_codes: entryAgg.htsDisplay,
        compared_digits: comparedDigits,
        invoice_numbers: ciDoc.invoiceNumbersBySku.get(sku) ?? [],
        line_number: meta.line_number,
        line_numbers: meta.line_numbers,
      },
      lineItemId: meta.lineItemId,
    });
  }

  // ---- Rule 14: per-SKU COO mismatch (currency-independent) --------------
  // Set semantics: flag only when the entry's origins and the CI's origins
  // for a SKU share nothing — a multi-origin SKU that overlaps is fine.
  for (const sku of entrySkus) {
    const ciAgg = ciDoc.bySku.get(sku);
    const entryAgg = entryBySku.get(sku)!;
    if (!ciAgg || ciAgg.coos.length === 0 || entryAgg.coos.length === 0)
      continue;
    if (entryAgg.coos.some((c) => ciAgg.coos.includes(c))) continue;
    const meta = skuLineMeta(sku);
    const invoiceNumbers = ciDoc.invoiceNumbersBySku.get(sku) ?? [];
    alerts.push({
      alertKey: `coo_discrepancy:invoice_sku:${sku}`,
      alertType: "coo_discrepancy",
      severity: "warning",
      label: "Origin differs from invoice",
      message: `${sku} is declared with origin ${entryAgg.coos.join(", ")}, but the commercial invoice logs ${ciAgg.coos.join(", ")}.`,
      details: {
        sku,
        declared_coo: entryAgg.coos[0],
        ...(ciAgg.coos.length === 1
          ? { expected_coo: ciAgg.coos[0] }
          : { expected_coos: ciAgg.coos }),
        // Presence of invoice_number(s) is what tells the COO detail UI
        // this came from a CI, not the catalog.
        invoice_number: invoiceNumbers[0],
        invoice_numbers: invoiceNumbers,
        line_number: meta.line_number,
        line_numbers: meta.line_numbers,
      },
      lineItemId: meta.lineItemId,
    });
  }

  return alerts;
}
