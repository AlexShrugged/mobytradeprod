// Column-1 special-rate parsing: turns the raw HTS "Special" cell text
// (hts_codes.col1_special, e.g. "Free (A*, AU, BH, CL, CO, D, E, IL, JO,
// KR, MA, OM, P, PA, PE, S, SG)") into rate segments keyed by SPI code, so
// the calculator can honor a line's declared Special Program Indicator (the
// prefix printed before the HTS number on a 7501 — an FTA/GSP preference
// claim).
//
// Doctrine (same as declared $0 exclusion codes): an SPI is the broker's
// CLAIM of preferential treatment. The deterministic layer accepts a
// schedule-supported claim and prices the special rate; it contests a claim
// only on affirmative grounds (the schedule's special column exists and
// does not list the SPI). When the special text is absent or unparseable
// the claim stays unverifiable and the audit stays silent — substantive
// eligibility (originating-goods rules, certificates) is the AI analyst's
// job, never this parser's.
//
// Relative imports on purpose — this module runs under the tsx seed script.

export type SpecialRateSegment = {
  /** Raw rate text as printed ("Free", "2.8%", "0.51¢/kg"). */
  rateText: string;
  /** Decimal fraction (0 for Free); null = specific/compound, not
   *  computable — same contract as the base-schedule rate column. */
  rate: number | null;
  /** SPI codes the segment covers, as printed ("A*", "AU", "KR"). */
  spiCodes: string[];
};

export type SpiEligibility =
  | { status: "eligible"; rate: number | null; rateText: string }
  | { status: "ineligible" }
  | { status: "unverifiable" };

// An SPI token: one or two letters plus an optional GSP-style marker
// ("A*", "A+", "S+"). Anything else inside the parenthetical (note
// references, prose) is not a code list entry.
const SPI_TOKEN = /^[A-Z]{1,2}[*+]?$/;

/** Marker-insensitive SPI identity: "A" claims the GSP family the schedule
 *  prints as "A*"/"A+". Collapsing the markers biases toward the claim,
 *  which is the deterministic layer's job — the analyst contests substance. */
function spiCore(token: string): string {
  return token.trim().toUpperCase().replace(/[*+]+$/, "");
}

function parseRate(text: string): number | null {
  if (/^free$/i.test(text)) return 0;
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
  // Decimal fraction at the schedule's numeric(10,6) precision — "2.8%"
  // must be exactly 0.028, not 2.8/100's float dust.
  if (pct) return Math.round(Number(pct[1]) * 10_000) / 1_000_000;
  return null; // specific/compound ("0.51¢/kg") — known, not computable
}

/** Segments of a special-rates cell: each "rate (SPI, SPI, ...)" pair.
 *  Parentheticals with no valid SPI tokens (footnote references) drop out;
 *  a missing rate prefix inherits the previous segment's. */
export function parseSpecialRates(text: string | null): SpecialRateSegment[] {
  if (!text) return [];
  const segments: SpecialRateSegment[] = [];
  let lastRateText = "";
  for (const m of text.matchAll(/([^()]*)\(([^()]*)\)/g)) {
    const rateText = m[1].trim().replace(/,$/, "").trim() || lastRateText;
    if (!rateText) continue;
    const spiCodes = m[2]
      .split(",")
      .map((t) => t.trim())
      .filter((t) => SPI_TOKEN.test(t.toUpperCase()));
    if (spiCodes.length === 0) continue;
    lastRateText = rateText;
    segments.push({ rateText, rate: parseRate(rateText), spiCodes });
  }
  return segments;
}

/** Whether a declared SPI is supported by a code's special-rates text.
 *  Null/blank text or a cell that yields no parseable segments =
 *  unverifiable (never grounds for contesting the claim); a parsed cell
 *  that lists no matching SPI = affirmatively ineligible. */
export function resolveSpiEligibility(
  col1Special: string | null | undefined,
  spi: string,
): SpiEligibility {
  const claimed = spiCore(spi);
  if (!claimed) return { status: "unverifiable" };
  const segments = parseSpecialRates(col1Special ?? null);
  if (segments.length === 0) return { status: "unverifiable" };
  for (const seg of segments) {
    if (seg.spiCodes.some((code) => spiCore(code) === claimed)) {
      return { status: "eligible", rate: seg.rate, rateText: seg.rateText };
    }
  }
  return { status: "ineligible" };
}
