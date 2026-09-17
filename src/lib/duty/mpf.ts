// Expected merchandise processing fee for one entry: the statutory ad
// valorem rate on the entered value CBP assesses it on, clamped to the
// fiscal year's per-entry minimum and maximum (19 CFR 24.23(b)(1)(i);
// figures in ./regulatory-params.ts). Pure; integer cents.
//
// The only 24.23(c) exemptions a 7501 LINE can claim are the preference
// programs declared through its SPI (the column-27 prefix) — those lines
// leave the fee basis. The others (chapter 98 articles, insular
// possessions, mail, and products of least-developed beneficiary developing
// countries, which CBP exempts by origin whether or not a preference is
// claimed — ASC's Cambodian valve entries print no 499 row at all) leave no
// mark on the line, which is why an ABSENT fee is never turned into a
// shortfall: audit rule 17 compares only a fee that was collected.
//
// Exempt programs verified against the 24.23(c) text (LII mirror,
// 2026-09-17): CBERA (E, E*, R), LDBDC (A+), USMCA (S, S+), Israel (IL),
// Singapore (SG), Chile (CL), Australia (AU), Bahrain (BH), CAFTA-DR (P,
// P+), Oman (OM), Peru (PE), Korea (KR), Colombia (CO), Panama (PA).
// Deliberately absent because the regulation does not list them: general
// GSP (A, A*), AGOA (D), Jordan (JO), Morocco (MA). A program wrongly left
// OUT of this set costs nothing (the fee CBP actually collected is what the
// rule compares); one wrongly put IN would flag a correctly collected fee.
//
// Relative imports on purpose — this module runs under the tsx seed script.

import {
  resolveRegulatoryParams,
  type RegulatoryParams,
} from "./regulatory-params";

export const MPF_EXEMPT_SPI: ReadonlySet<string> = new Set([
  "E",
  "E*",
  "R",
  "A+",
  "S",
  "S+",
  "IL",
  "SG",
  "CL",
  "AU",
  "BH",
  "P",
  "P+",
  "OM",
  "PE",
  "KR",
  "CO",
  "PA",
]);

/** The declared SPI as the schedule prints it; null when blank. */
export function normalizeSpi(spi: string | null | undefined): string | null {
  if (!spi) return null;
  const s = spi.trim().toUpperCase();
  return s === "" ? null : s;
}

export function isMpfExemptClaim(spi: string | null | undefined): boolean {
  const s = normalizeSpi(spi);
  return s !== null && MPF_EXEMPT_SPI.has(s);
}

export type MpfLineInput = {
  lineNumber: number;
  enteredCents: number;
  spi: string | null;
};

export type MpfExpectation = {
  params: RegulatoryParams;
  /** Entered value the fee is assessed on: the lines without an exempt claim. */
  basisCents: number;
  /** Rate × basis before the clamp. */
  adValoremCents: number;
  expectedCents: number;
  /** Which limb of the statute produced the expectation. */
  bound: "exempt" | "minimum" | "maximum" | "ad_valorem";
  exemptLineNumbers: number[];
};

/** Null when the fiscal year's parameters are unknown (a date before the
 *  earliest window) — the platform must not assert a floor it cannot cite. */
export function computeExpectedMpf(
  entryDate: string,
  lines: MpfLineInput[],
): MpfExpectation | null {
  const params = resolveRegulatoryParams(entryDate);
  if (!params) return null;
  let basisCents = 0;
  const exemptLineNumbers: number[] = [];
  for (const l of lines) {
    if (isMpfExemptClaim(l.spi)) exemptLineNumbers.push(l.lineNumber);
    else basisCents += Math.max(0, l.enteredCents);
  }
  if (lines.length > 0 && exemptLineNumbers.length === lines.length) {
    return {
      params,
      basisCents: 0,
      adValoremCents: 0,
      expectedCents: 0,
      bound: "exempt",
      exemptLineNumbers,
    };
  }
  const adValoremCents = Math.round(basisCents * params.mpf.rate);
  let expectedCents = adValoremCents;
  let bound: MpfExpectation["bound"] = "ad_valorem";
  if (adValoremCents < params.mpf.minCents) {
    expectedCents = params.mpf.minCents;
    bound = "minimum";
  } else if (adValoremCents > params.mpf.maxCents) {
    expectedCents = params.mpf.maxCents;
    bound = "maximum";
  }
  return {
    params,
    basisCents,
    adValoremCents,
    expectedCents,
    bound,
    exemptLineNumbers,
  };
}
