// Effective-dated regulatory fee parameters (COBRA-adjusted MPF limitations,
// HMF rate): the platform's statutory floor and cap. Audit rule 17
// (audit/rules.ts, via duty/mpf.ts) checks the MPF a 7501 declares against
// them, and the entry analyst cites them through get_regulatory_params. Fees
// are still never COMPUTED for storage or display — the declared figure stays
// the ingested fact (see duty/fees.ts); these parameters only say what CBP
// would have assessed. Constant array today, one row per fiscal year added
// when CBP's annual notice lands (early August, effective October 1); a
// future regulatory_params table replaces it behind the same resolve
// function.
//
// Figures transcribed from CBP's annual Federal Register COBRA fee-adjustment
// notices (19 CFR 24.23), verified against the govinfo full text — never
// model memory. The MPF ad valorem rate (0.3464%) is statutory and excluded
// from the annual adjustment; the HMF (0.125%, 19 CFR 24.24) has no
// per-entry minimum or maximum.
//
// Relative imports on purpose — this module runs under the tsx eval script.

import { HMF_RATE, MPF_RATE } from "./fees";

export type RegulatoryParams = {
  fiscalYear: number;
  /** First day the figures apply (always October 1). */
  effectiveFrom: string;
  /** Last day, inclusive (September 30); null = current fiscal year. */
  effectiveTo: string | null;
  mpf: {
    rate: number;
    /** Formal-entry per-entry minimum (class code 499), integer cents. */
    minCents: number;
    /** Per-entry maximum (cap), integer cents. */
    maxCents: number;
  };
  hmf: { rate: number };
  /** Federal Register citation for the fiscal year's adjustment notice. */
  source: string;
};

export const REGULATORY_PARAMS: RegulatoryParams[] = [
  {
    fiscalYear: 2025,
    effectiveFrom: "2024-10-01",
    effectiveTo: "2025-09-30",
    mpf: { rate: MPF_RATE, minCents: 3271, maxCents: 63462 },
    hmf: { rate: HMF_RATE },
    source: "89 FR 59126 (CBP Dec. 24-11, July 22, 2024)",
  },
  {
    fiscalYear: 2026,
    effectiveFrom: "2025-10-01",
    effectiveTo: null,
    mpf: { rate: MPF_RATE, minCents: 3358, maxCents: 65150 },
    hmf: { rate: HMF_RATE },
    source: "90 FR 34665 (CBP Dec. 25-10, July 23, 2025)",
  },
];

/** The parameters in force on an ISO date. Dates past the newest window fall
 *  back to that window (the current figures until the next notice lands);
 *  dates before the earliest window return null — we don't know those years'
 *  figures and must not pretend to. */
export function resolveRegulatoryParams(date: string): RegulatoryParams | null {
  let latest: RegulatoryParams | null = null;
  for (const p of REGULATORY_PARAMS) {
    if (date >= p.effectiveFrom && (p.effectiveTo === null || date <= p.effectiveTo)) {
      return p;
    }
    if (!latest || p.effectiveFrom > latest.effectiveFrom) latest = p;
  }
  return latest && date > latest.effectiveFrom ? latest : null;
}
