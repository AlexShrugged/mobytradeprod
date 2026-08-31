import type {
  EntryChargeExtraction,
  EntryLineItemExtraction,
  PortEntryExtraction,
} from "./types";

// A CBP 7501 is a self-checking document: every ad-valorem duty charge
// prints both its rate and its computed amount, and the header prints the
// totals the lines must sum to. This module replays that arithmetic against
// a mapped extraction and reports where the extraction contradicts the
// document's own printed figures — the deterministic tripwire for the
// classic multi-line misreads: two numbered lines merged into one, an
// invoice-block "Entered Value USD" subtotal taken as a line's entered
// value, a dropped declaration line. Pure math over PortEntryExtraction;
// no IO. The processor retries the extract once with these findings spelled
// out, then fails closed — a provably wrong duty ledger must never persist
// as fact (ASC entry 231-7376568-3: lines 001+002 merged under the $8,070
// trailer, raising false duty variances equal to line 002's real duties).

export type PortEntryReconcileFinding = {
  kind: "line_basis" | "entered_value_total" | "duty_total";
  lineNumber: number | null;
  message: string;
};

// Only ad-valorem duty types obey amount = rate × entered value. MPF/HMF
// carry per-entry minimums and caps (ingested facts, never computed — see
// CLAUDE.md), so their printed amounts legitimately break the proportion.
const AD_VALOREM_DUTY_TYPES = new Set<EntryChargeExtraction["charge_type"]>([
  "base_duty",
  "additional_duty",
  "antidumping",
  "countervailing",
]);

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const pct = (rate: number): string =>
  `${parseFloat((rate * 100).toFixed(4))}%`;

type RatedDutyCharge = {
  code: string | null;
  chargeType: EntryChargeExtraction["charge_type"];
  rate: number;
  amount: number;
  /** The duty basis this charge's printed figures imply: amount / rate. */
  implied: number;
  /** Half-cent print rounding on the amount, plus $1 whole-dollar slack. */
  tol: number;
};

/**
 * A line's entered value is provably wrong when two or more DISTINCT rated
 * duty charges agree with each other on an implied basis that disagrees
 * with the extracted entered value. One dissenting charge alone proves
 * nothing: a Section 232 metal-content duty legitimately uses the declared
 * content value, not the line's entered value, as its basis — and a
 * schedule-side specific rate can make a lone implied basis meaningless.
 * Symmetrically, when any two distinct charges corroborate the entered
 * value itself, the line reconciles regardless of other clusters.
 */
function reconcileLineBasis(
  line: EntryLineItemExtraction,
): PortEntryReconcileFinding | null {
  const candidates: RatedDutyCharge[] = [];
  for (const charge of line.charges) {
    if (!AD_VALOREM_DUTY_TYPES.has(charge.charge_type)) continue;
    if (charge.rate === null || charge.rate <= 0 || charge.amount <= 0) {
      continue; // $0 amounts are exclusion claims; rateless rows prove nothing
    }
    candidates.push({
      code: charge.hts_code,
      chargeType: charge.charge_type,
      rate: charge.rate,
      amount: charge.amount,
      implied: charge.amount / charge.rate,
      tol: 0.005 / charge.rate + 1,
    });
  }
  if (candidates.length < 2) return null;

  // Anchored clusters of charges agreeing on one basis, sized by distinct
  // charge identity so a duplicated row can't corroborate itself.
  const clusters = candidates
    .map((anchor) => {
      const members = candidates.filter(
        (c) => Math.abs(c.implied - anchor.implied) <= c.tol + anchor.tol,
      );
      const identities = new Set(
        members.map((m) => `${m.chargeType}:${m.code ?? ""}`),
      );
      const rep = members.reduce((a, b) => (b.tol < a.tol ? b : a));
      return { members, identities: identities.size, rep };
    })
    .filter((cluster) => cluster.identities >= 2);
  if (clusters.length === 0) return null;

  const supportsEnteredValue = (cluster: (typeof clusters)[number]) =>
    Math.abs(cluster.rep.implied - line.entered_value) <=
    Math.max(cluster.rep.tol, 2, 0.02 * line.entered_value);
  if (clusters.some(supportsEnteredValue)) return null;

  const best = clusters.reduce((a, b) =>
    b.members.length > a.members.length ||
    (b.members.length === a.members.length && b.rep.tol < a.rep.tol)
      ? b
      : a,
  );
  const evidence = best.members
    .map((m) => `${m.code ?? m.chargeType}: ${usd(m.amount)} at ${pct(m.rate)}`)
    .join("; ");
  return {
    kind: "line_basis",
    lineNumber: line.line_number,
    message:
      `Line ${line.line_number} (HTS ${line.hts_code}): entered value ` +
      `extracted as ${usd(line.entered_value)}, but its printed duty ` +
      `charges imply ${usd(best.rep.implied)} (${evidence}).`,
  };
}

export function reconcilePortEntry(
  fields: PortEntryExtraction,
): PortEntryReconcileFinding[] {
  const findings: PortEntryReconcileFinding[] = [];
  for (const line of fields.line_items) {
    const finding = reconcileLineBasis(line);
    if (finding) findings.push(finding);
  }

  if (fields.total_entered_value !== null && fields.line_items.length > 0) {
    const sum = fields.line_items.reduce(
      (acc, line) => acc + line.entered_value,
      0,
    );
    // Entered values print whole-dollar; allow $1 of rounding per line.
    const tol = Math.max(
      2 + fields.line_items.length,
      0.005 * fields.total_entered_value,
    );
    if (Math.abs(sum - fields.total_entered_value) > tol) {
      findings.push({
        kind: "entered_value_total",
        lineNumber: null,
        message:
          `The extracted lines' entered values sum to ${usd(sum)} but the ` +
          `header Total Entered Value is ` +
          `${usd(fields.total_entered_value)} — a declaration line is ` +
          `missing or misvalued.`,
      });
    }
  }

  if (fields.total_duty !== null && fields.line_items.length > 0) {
    const sum = fields.line_items.reduce(
      (lineAcc, line) =>
        lineAcc +
        line.charges.reduce(
          (acc, charge) =>
            AD_VALOREM_DUTY_TYPES.has(charge.charge_type)
              ? acc + charge.amount
              : acc,
          0,
        ),
      0,
    );
    const tol = Math.max(2, 0.005 * fields.total_duty);
    if (Math.abs(sum - fields.total_duty) > tol) {
      findings.push({
        kind: "duty_total",
        lineNumber: null,
        message:
          `The extracted duty charges sum to ${usd(sum)} but the header ` +
          `total duty is ${usd(fields.total_duty)} — duty charges are ` +
          `missing or misread.`,
      });
    }
  }

  return findings;
}

/** The corrective addendum for the one retry extract: the findings in the
 *  document's own arithmetic, plus the line discipline that repairs them. */
export function reconcileRetryAddendum(
  findings: PortEntryReconcileFinding[],
): string {
  return (
    "A previous extraction of this document FAILED arithmetic " +
    "reconciliation against the form's own printed figures:\n" +
    findings.map((f) => `- ${f.message}`).join("\n") +
    "\nRe-read the document and correct this. Every numbered line (001, " +
    "002, ...) is its own line_item with the entered value, quantity, and " +
    "charge stack from its own rows — never merge numbered lines. An " +
    "'Invoice Value USD' / 'Entered Value USD' trailer printed after a " +
    "group of lines is an invoice-block subtotal, never a line's entered " +
    "value. On every line, each printed ad-valorem duty amount must equal " +
    "its rate times that line's entered value."
  );
}
