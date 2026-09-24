// Preference programs a 7501 SPI can claim, and the windows in which they
// are NOT in force — the one thing the schedule's special-rates column
// cannot say. The column still prints "A*"/"A+" beside GSP-eligible codes,
// but the Generalized System of Preferences (19 U.S.C. 2461 et seq.)
// expired on 2020-12-31 and has not been reauthorized; CBP's lapse guidance
// (CSMS #45244051, January 2021) tells filers to keep SPI "A" (A*, A+) on
// eligible goods AND pay the general rate, so a refund can follow a
// retroactive renewal. A lapsed claim therefore prices nothing: the general
// rate stands as the expectation, exactly as for an unverifiable claim, and
// a base duty paid at the general rate is the correct filing — never an
// overpayment or a refund opportunity. Found 2026-09-24, the day the loader
// started resolving the special text onto statistical suffixes: ASC's "A"
// lines (valves, fittings) drew 52 false rate/amount alerts within the hour.
//
// Constant array today, like duty/regulatory-params.ts: when a program is
// reauthorized, close its lapse at the day before the effective date and
// cite the act (a retroactive refund runs through CBP's liquidation, not
// through this audit). Never model memory — cite the statute or notice.
//
// Relative imports on purpose — this module runs under the tsx eval script.

export type PreferenceLapse = {
  program: string;
  /** SPI cores the program is claimed under (markers such as "*" and "+"
   *  collapsed, as duty/special-rates.ts does). */
  spis: string[];
  /** First entry date the program was not in force (inclusive). */
  from: string;
  /** Last entry date not in force (inclusive); null = still lapsed. */
  to: string | null;
  source: string;
};

export const PREFERENCE_LAPSES: PreferenceLapse[] = [
  {
    program: "GSP",
    spis: ["A"],
    from: "2021-01-01",
    to: null,
    source:
      "19 U.S.C. 2465 (authority expired 2020-12-31); CBP CSMS #45244051 (lapse filing guidance)",
  },
];

function spiCore(token: string): string {
  return token.trim().toUpperCase().replace(/[*+]+$/, "");
}

/** The lapse a claimed SPI falls in on an entry date, or null when the
 *  program is in force (or nothing is known about it). A null entry date
 *  decides nothing — the claim proceeds against the schedule as before. */
export function lapsedProgram(
  spi: string,
  entryDate: string | null,
  lapses: PreferenceLapse[] = PREFERENCE_LAPSES,
): PreferenceLapse | null {
  if (!entryDate) return null;
  const core = spiCore(spi);
  if (!core) return null;
  for (const lapse of lapses) {
    if (!lapse.spis.some((s) => spiCore(s) === core)) continue;
    if (lapse.from <= entryDate && (lapse.to === null || entryDate <= lapse.to)) {
      return lapse;
    }
  }
  return null;
}
