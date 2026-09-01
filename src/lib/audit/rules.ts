// Pure audit rule evaluation: (entry snapshot, reference data) -> desired
// alerts. No DB, no IO. The auditor persists the result; tests call this
// directly. Money is compared in integer cents; tolerances and the severity
// ladder are legacy-verified values.
//
// Document-comparison doctrine (settled 2026-08-06): the COMMERCIAL INVOICE
// is the only document class an entry is compared against for variance —
// the CI rules live in ./invoice-rules.ts. PO and shipment document
// comparisons were deliberately retired (the old rule 7 PO-total check is
// gone; PO scope never matched entry scope). Catalog comparisons (rules 5
// and 10) remain: they check the entry against master data, a different
// axis than documents.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import { computeExpectedCharges, isExemptionActive } from "../duty/calculator";
import type { ReferenceData, SailBasis, SailInfo } from "../duty/types";
import type {
  AuditAlertTypeValue,
  AuditSeverityValue,
  ChargeTypeValue,
} from "../db/schema";
import { computeInvoiceAlerts } from "./invoice-rules";

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
  /** Special Program Indicator declared on the line (claimed FTA/GSP
   *  preference). Optional so rule-test fixtures stay untouched. */
  spi?: string | null;
  countryOfOrigin: string | null;
  /** The linked catalog part (draft included — a draft SKU is known, its
   *  facts just aren't committed); null = the catalog has no part for this
   *  SKU. Feeds rule 16 only. Optional so rule-test fixtures stay
   *  untouched. */
  partId?: string | null;
  /** Resolved per-line vendor; null when the 7501 named no supplier. */
  vendorId: string | null;
  enteredValue: string;
  quantity: string | null;
  /** Catalog HTS AS OF THE ENTRY DATE when the line matched a part; null
   *  otherwise. The governing expectation: what the catalog said the code
   *  was on the day this entry was filed. */
  partHtsCode: string | null;
  /** Catalog HTS under the CURRENT classification window (today's opinion).
   *  Differs from partHtsCode when the part was reclassified after the
   *  entry — the retroactive-correction signal. */
  partHtsCodeCurrent: string | null;
  /** valid_from of the current classification window; null = open start or
   *  no current window. Display metadata for the reclassified signal. */
  partHtsCurrentSince: string | null;
  /** The matched part's (vendor, COO) sourcing facts AS OF THE ENTRY DATE —
   *  empty when the line matched no part or the part is draft (nothing on a
   *  draft is committed). */
  partSources: {
    vendorId: string;
    vendorName: string;
    countryOfOrigin: string | null;
  }[];
  /** Free-text goods description as declared on the 7501 line. No rule reads
   *  it — loaded for readers (the entry analyst) that reason about
   *  descriptions. Optional so rule-test fixtures stay untouched. */
  description?: string | null;
  /** Supplier name as declared on the line. No rule reads it, but the
   *  suppression evaluator (./suppression.ts) matches supplier-scoped org
   *  rules against it. Optional so rule-test fixtures stay untouched. */
  supplierName?: string | null;
  charges: AuditableCharge[];
};

export type AuditableInvoiceLine = {
  sku: string | null;
  /** HTS/HS code as printed on the invoice line — often 6/8 digits. */
  htsCode: string | null;
  htsCodeDigits: string | null;
  countryOfOrigin: string | null;
  quantity: string | null;
  totalPrice: string;
};

/** An invoice-level row between the goods lines and the final total —
 *  discount, rebate, credit, freight. Amount signed as printed. */
export type AuditableInvoiceAdjustment = {
  label: string;
  amount: string;
};

export type AuditableInvoice = {
  invoiceNumber: string;
  /** ISO 4217. Money comparisons gate on USD — there is no FX support, and
   *  comparing a EUR invoice against USD entered value fabricates variance. */
  currency: string;
  /** The final amount payable as printed, after any adjustments. */
  totalAmount: string | null;
  /** Goods total before adjustments, when the invoice prints one. */
  subtotal: string | null;
  /** Adjustment rows in printed order; empty on a plain invoice. */
  adjustments: AuditableInvoiceAdjustment[];
  lines: AuditableInvoiceLine[];
  /** How many entries this invoice links to via entry_invoices. SKU and
   *  header checks require exactly 1 — an invoice spanning entries cannot
   *  reconcile against any single one (normal consolidation, not a finding). */
  linkedEntryCount: number;
};

export type AuditableEntry = {
  entryDate: string | null;
  /** Whether the org has ANY catalog part — the gate on rule 16 (unknown
   *  SKU). Optional so rule-test fixtures stay untouched (omitted = no
   *  catalog, rule dormant). */
  orgHasCatalog?: boolean;
  totalEnteredValue: string | null;
  totalDuty: string | null;
  /** Resolved sail window of the linked shipments (resolveSailInfo);
   *  null = the loader had no shipment data. */
  sail: SailInfo | null;
  lines: AuditableLine[];
  /** Invoices DIRECTLY linked via entry_invoices — the primary document
   *  truth the entry is checked against (see invoice-rules.ts). */
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
  /** CI-vs-entry quantity comparison tolerance, in units. */
  quantityToleranceUnits: number;
};

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  amountToleranceAbsCents: 2,
  amountTolerancePct: 0.01,
  valueToleranceAbsCents: 100,
  valueTolerancePct: 0.01,
  trustGateAbsCents: 200,
  trustGatePct: 0.01,
  quantityToleranceUnits: 0.01,
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

// Money helpers, shared with invoice-rules.ts.
export const toCents = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);
export const dollars = (cents: number) => cents / 100;
export const fmt = (cents: number) =>
  `$${Math.abs(dollars(cents)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const pctLabel = (rate: number) => `${Math.round(rate * 10000) / 100}%`;

/** error > $50 or > 10%; warning > $5 or > 2%; else info. */
export function moneySeverity(
  diffCents: number,
  baseCents: number,
): AuditSeverityValue {
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
  // The comparison target is the catalog code AS OF THE ENTRY DATE — the
  // expectation that governed the filing. Rule 5b catches the complement:
  // the declaration matched its day's expectation, but the part has since
  // been reclassified, so duty may be retroactively recoverable.
  const htsDiscrepancyLines = new Set<string>();
  for (const line of entry.lines) {
    if (!line.partHtsCode) continue;
    const catalogDigits = line.partHtsCode.replace(/\D/g, "");
    const currentDigits = line.partHtsCodeCurrent?.replace(/\D/g, "") ?? null;
    if (catalogDigits === line.htsCodeDigits) {
      // ---- Rule 5b: reclassified after filing --------------------------
      if (currentDigits !== null && currentDigits !== catalogDigits) {
        alerts.push({
          alertKey: `hts_reclassified:line${line.lineNumber}`,
          alertType: "hts_reclassified",
          severity: "info",
          label: "Classification changed after filing",
          message: `Line ${line.lineNumber} (${line.sku ?? "no SKU"}) was filed under ${line.htsCode}, which matched the catalog at entry time; the part is now classified ${line.partHtsCodeCurrent}${line.partHtsCurrentSince ? ` (effective ${line.partHtsCurrentSince})` : ""}. If the reclassification applies retroactively, duty may be recoverable.`,
          details: {
            declared_hts: line.htsCode,
            expected_hts_as_of: line.partHtsCode,
            expected_hts_current: line.partHtsCodeCurrent,
            current_effective_from: line.partHtsCurrentSince,
            line_number: line.lineNumber,
            sku: line.sku,
          },
          lineItemId: line.id,
        });
      }
      // The declared code matched the governing expectation of its day —
      // money rules still run (no htsDiscrepancyLines suppression).
      continue;
    }
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
        expected_hts_as_of: line.partHtsCode,
        expected_hts_current: line.partHtsCodeCurrent,
        actual_hts: line.htsCode,
        line_number: line.lineNumber,
        sku: line.sku,
      },
      lineItemId: line.id,
    });
  }

  // ---- Rule 10: COO vs catalog (runs regardless of the trust gate) ------
  // The catalog's sourcing truth is per (part, vendor). When the line names
  // a vendor we know for this part, its source COO is THE expectation
  // (warning on mismatch). When the vendor is unknown — or known but with no
  // source row — any source origin is acceptable; only a COO no vendor of
  // this part carries gets flagged, and softly (info): we can't pin which
  // vendor should have shipped it. Never suppresses rules 1-4 — money
  // expectations run on the DECLARED origin, which is the customs fact.
  for (const line of entry.lines) {
    if (!line.countryOfOrigin || line.partSources.length === 0) continue;

    const vendorSource =
      line.vendorId === null
        ? undefined
        : line.partSources.find((s) => s.vendorId === line.vendorId);

    if (vendorSource) {
      if (
        vendorSource.countryOfOrigin !== null &&
        vendorSource.countryOfOrigin !== line.countryOfOrigin
      ) {
        alerts.push({
          alertKey: `coo_discrepancy:line${line.lineNumber}`,
          alertType: "coo_discrepancy",
          severity: "warning",
          label: "Origin differs from catalog",
          message: `Line ${line.lineNumber} (${line.sku ?? "no SKU"}) is declared with origin ${line.countryOfOrigin}, but the catalog sources this part from ${vendorSource.vendorName} with origin ${vendorSource.countryOfOrigin}.`,
          details: {
            declared_coo: line.countryOfOrigin,
            expected_coo: vendorSource.countryOfOrigin,
            vendor_name: vendorSource.vendorName,
            line_number: line.lineNumber,
            sku: line.sku,
          },
          lineItemId: line.id,
        });
      }
    } else {
      const knownCoos = [
        ...new Set(
          line.partSources
            .map((s) => s.countryOfOrigin)
            .filter((c): c is string => c !== null),
        ),
      ].sort();
      if (knownCoos.length > 0 && !knownCoos.includes(line.countryOfOrigin)) {
        alerts.push({
          alertKey: `coo_discrepancy:line${line.lineNumber}`,
          alertType: "coo_discrepancy",
          severity: "info",
          label: "Origin differs from catalog",
          message: `Line ${line.lineNumber} (${line.sku ?? "no SKU"}) is declared with origin ${line.countryOfOrigin}, but no catalog vendor for this part has that origin (${knownCoos.join(", ")}).`,
          details: {
            declared_coo: line.countryOfOrigin,
            expected_coos: knownCoos,
            line_number: line.lineNumber,
            sku: line.sku,
          },
          lineItemId: line.id,
        });
      }
    }
  }

  // ---- Rule 16: SKU vs catalog (runs regardless of the trust gate) -------
  // A declared SKU with no catalog part behind it. The linker and adopter
  // match on the normalized SKU key, so by audit time an unlinked SKU is
  // genuinely absent from the catalog, not a spelling difference — either
  // the catalog has a gap or the filing carries a bad SKU, and rules 5/10
  // silently skip the line either way. Gated on the org having a catalog at
  // all: before the first part exists the whole catalog axis is dormant,
  // and flagging every line would bury a new org in noise. A draft
  // (quote-created) part counts as known — its facts are uncommitted, not
  // missing.
  if (entry.orgHasCatalog) {
    for (const line of entry.lines) {
      if (line.sku === null || line.partId != null) continue;
      alerts.push({
        alertKey: `unknown_sku:line${line.lineNumber}`,
        alertType: "unknown_sku",
        severity: "warning",
        label: "SKU not in catalog",
        message: `Line ${line.lineNumber} is declared with SKU ${line.sku}, which is not in the parts catalog. Catalog checks (HTS, origin) cannot run on this line until the part exists.`,
        details: {
          sku: line.sku,
          line_number: line.lineNumber,
          declared_hts: line.htsCode,
          declared_coo: line.countryOfOrigin,
          description: line.description ?? null,
          supplier_name: line.supplierName ?? null,
        },
        lineItemId: line.id,
      });
    }
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
          spi: line.spi ?? null,
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
        // Non-ad-valorem measures (rate null) are presence-checked with the
        // raw rate text; no expected amount can be quoted.
        const rateLabel =
          m.rate === null
            ? (m.rateText ?? "a non-ad-valorem rate")
            : pctLabel(m.rate);
        const amountClause =
          m.amountCents === null
            ? " (amount not auto-computed for this rate type)"
            : ` (expected ${fmt(m.amountCents)})`;
        alerts.push({
          alertKey: `missing_measure:line${line.lineNumber}:${m.ch99Digits}`,
          alertType: "missing_measure",
          severity: "warning",
          label: `Missing ${m.name}`,
          message: `Line ${line.lineNumber} (${line.htsCode}, ${line.countryOfOrigin}) should carry ${m.name} (${m.ch99Code}) at ${rateLabel}${amountClause}, but no such charge was declared.`,
          details: {
            measure_name: m.name,
            authority: m.authority,
            expected_hts: m.ch99Code,
            expected_rate: m.rate,
            expected_amount: m.amountCents === null ? null : dollars(m.amountCents),
            line_number: line.lineNumber,
            sku: line.sku,
          },
          lineItemId: line.id,
        });
      }

      // Rule 1b: dutiable schedule rate with no base duty charge. A
      // declared SPI is a preference claim: schedule-supported claims
      // already priced the special rate into expected.baseDuty (a Free
      // rate never reaches this alert), an unverifiable claim silences
      // the rule (a claim is never turned into duty owed without
      // affirmative grounds — the analyst contests substance), and only
      // an SPI the special column affirmatively does not list leaves the
      // general-rate expectation standing, with the rejected claim named.
      const hasBaseCharge = line.charges.some(
        (c) => c.chargeType === "base_duty",
      );
      const claim = expected.baseDutyClaim;
      if (
        !hasBaseCharge &&
        claim?.status !== "unverifiable" &&
        expected.baseDuty !== null &&
        expected.baseDuty.rate !== null &&
        expected.baseDuty.rate > 0 &&
        expected.baseDuty.amountCents !== null &&
        expected.baseDuty.amountCents > 0
      ) {
        const rateClause =
          claim?.status === "eligible"
            ? `a ${pctLabel(expected.baseDuty.rate)} special rate under SPI ${claim.spi}`
            : `a ${pctLabel(expected.baseDuty.rate)} general rate`;
        const claimClause =
          claim?.status === "ineligible"
            ? ` The declared SPI ${claim.spi} is not among this code's special-rate programs.`
            : "";
        alerts.push({
          alertKey: `missing_base_duty:line${line.lineNumber}`,
          alertType: "missing_measure",
          severity: "warning",
          label: "Missing base duty",
          message: `Line ${line.lineNumber} (${line.htsCode}) has ${rateClause} (expected ${fmt(expected.baseDuty.amountCents)}), but no base duty charge was declared.${claimClause}`,
          details: {
            expected_rate: expected.baseDuty.rate,
            expected_amount: dollars(expected.baseDuty.amountCents),
            claimed_spi: claim?.spi ?? null,
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

        // Exclusion codes are allowed — but only on entries their measure
        // window covers (entry-date-aware; falls back to the current-row
        // flag when the ref carries no exemption windows).
        if (isExemptionActive(c.htsCodeDigits, entry.entryDate!, ref)) continue;
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
        // A carve-out displacement is claim-aware: the calculator displaces
        // on SCOPE (the trigger program covers the line), but a declared
        // exclusion of the trigger program's own family asserts the trigger
        // does not actually charge — and then this measure's liability
        // correctly stands. The two filings are alternative bundles; only a
        // mixed bundle (trigger charged, or nothing declared for the
        // trigger) makes this charge a swap leg worth flagging.
        const carveout = suppressedMatch?.suppressedBy.carveout;
        if (carveout) {
          const trigger = expected.measures.find(
            (m) => m.program === carveout.triggerProgram,
          );
          const negated = trigger?.exclusionDigits.some((d) =>
            declaredDigits.has(d),
          );
          if (negated) continue;
        }
        const name =
          suppressedMatch?.name ?? refMeasure?.name ?? c.htsCode ?? "measure";
        alerts.push({
          alertKey: `unexpected_measure:line${line.lineNumber}:${c.htsCodeDigits}`,
          alertType: "unexpected_measure",
          severity: suppressedMatch ? "warning" : "info",
          label: `Unexpected ${name}`,
          message: suppressedMatch
            ? `Line ${line.lineNumber} declares ${name} (${c.htsCode}) for ${fmt(amountCents)}, but it should not apply: ${suppressedMatch.suppressedBy.reason}`
            : `Line ${line.lineNumber} declares ${name} (${c.htsCode}) for ${fmt(amountCents)}, which our reference data does not show applying to ${line.htsCode} from ${line.countryOfOrigin}. This may be a coverage gap; review before acting.`,
          details: {
            measure_name: name,
            actual_hts: c.htsCode,
            actual_amount: dollars(amountCents),
            line_number: line.lineNumber,
            sku: line.sku,
            ...(suppressedMatch
              ? { stacking_reason: suppressedMatch.suppressedBy.reason }
              : {}),
            ...(carveout
              ? { expected_exemption: carveout.expectedExemptionCode }
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

        // Rule 3: declared rate deviates from the official rate. When an
        // eligible SPI claim set the base expectation, say so — "official
        // rate" alone would misread as the general rate.
        const spiClause =
          c.chargeType === "base_duty" &&
          expected.baseDutyClaim?.status === "eligible"
            ? ` under SPI ${expected.baseDutyClaim.spi}`
            : "";
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
            message: `Line ${line.lineNumber} ${c.htsCode ?? "base duty"} is declared at ${pctLabel(declaredRate)}; the official rate${spiClause} is ${pctLabel(expectedRate)}.`,
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
        message: `Sail-conditioned tariff expectations on line(s) ${[...sailAffectedLines].sort((a, b) => a - b).join(", ")} were computed from ${basisLabel}. Confirm the on-board date from the bill of lading; the applicable measure set may change.`,
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

  // ---- Rules 8-15: commercial-invoice document comparisons ---------------
  // The CI is the primary document the entry is checked against; the whole
  // family lives in invoice-rules.ts.
  alerts.push(...computeInvoiceAlerts(entry, config));

  return alerts;
}

function declaredMatchesExpected(
  digits: string,
  measures: { ch99Digits: string }[],
): boolean {
  return measures.some((m) => m.ch99Digits === digits);
}
