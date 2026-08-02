// Deterministic parse of Chapter 99 "general" rate text. The USITC idiom
// for an additional duty is "The duty provided in the applicable subheading
// + 25%"; a bare "The duty provided in the applicable subheading" (no
// surcharge) marks an exemption/in-transit line. Anything compound or
// specific stays unparsed and a human supplies the rate at review time.

import type { ParsedBaseRate, ParsedRate } from "./types";

const NONE_TEXTS = new Set(["", "free", "no change"]);

export function parseGeneralRate(text: string): ParsedRate {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (NONE_TEXTS.has(lower)) return { kind: "none" };

  const additional = lower.match(
    /^the duty provided in the applicable subheading\s*(?:\+\s*([\d.]+)\s*%)?\s*$/,
  );
  if (additional) {
    if (additional[1] === undefined) return { kind: "none" };
    const pct = Number(additional[1]);
    if (Number.isFinite(pct)) {
      return { kind: "additional", rate: round6(pct / 100) };
    }
  }

  const bare = lower.match(/^([\d.]+)\s*%$/);
  if (bare) {
    const pct = Number(bare[1]);
    if (Number.isFinite(pct)) return { kind: "ad_valorem", rate: round6(pct / 100) };
  }

  return { kind: "unparsed", text: t };
}

/** Classify a BASE-schedule (chapters 1–97) column-1 general cell. "Free"
 *  and bare percentages are computable; specific ("14.27¢/liter") and
 *  compound ("4.4¢/kg + 3.2%") rates keep their raw text for display and
 *  carry rate null — v1 never computes them. Blank cells never reach here:
 *  the base ETL treats a blank as "inherit from the nearest rate-bearing
 *  ancestor" (standard HTSUS structure — the rate is stated once on the
 *  subheading; 10-digit statistical suffixes are blank). */
export function parseBaseRate(text: string): ParsedBaseRate {
  const t = text.trim();
  const parsed = parseGeneralRate(t);
  if (parsed.kind === "ad_valorem") {
    return { rateType: "ad_valorem", rate: parsed.rate };
  }
  if (parsed.kind === "none") return { rateType: "free", rate: 0 };
  // "additional" is a Chapter 99 idiom that never appears in the base
  // schedule; if it somehow does, it is not a computable base rate.
  if (parsed.kind === "additional") return { rateType: "other", rate: null };

  const hasAdValorem = /%/.test(t);
  const hasSpecific = /[¢$]|\bcents?\b/i.test(t);
  if (hasAdValorem && hasSpecific) return { rateType: "compound", rate: null };
  if (hasSpecific) return { rateType: "specific", rate: null };
  return { rateType: "other", rate: null };
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
