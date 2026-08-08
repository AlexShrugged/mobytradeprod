// Pure field-level diff between a revision's live snapshot and its
// proposal — what the review card renders as "what changes" (the variance
// pages' live-vs-expected idiom applied to reference data). Only fields
// that actually differ produce rows; a create_measure has no live side and
// diffs to nothing (the card shows the full proposal summary instead).

import type { LiveMeasureSnapshot, ProposedMeasureChange } from "./types";

export type RevisionFieldDiff = {
  field: string;
  live: string;
  proposed: string;
};

const pct = (rate: number) => `${Math.round(rate * 10000) / 100}%`;

export function rateLabel(v: {
  rate: number | null;
  rateText?: string | null;
  exemption: boolean;
}): string {
  if (v.exemption) return "exempt";
  if (v.rate !== null) return pct(v.rate);
  return v.rateText ?? "?";
}

export function countriesLabel(v: {
  countries: string[] | null;
  countriesExcluded?: string[] | null;
}): string {
  if (v.countriesExcluded && v.countriesExcluded.length > 0) {
    return `all except ${v.countriesExcluded.join(", ")}`;
  }
  return v.countries && v.countries.length > 0
    ? v.countries.join(", ")
    : "all countries";
}

export function coverageLabel(v: {
  scope: "all_products" | "hts_list";
  prefixes: string[];
}): string {
  return v.scope === "all_products"
    ? "all products"
    : `${v.prefixes.length} HTS prefix${v.prefixes.length === 1 ? "" : "es"}`;
}

const truncate = (s: string, n = 90) =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

export function diffRevisionFields(
  live: LiveMeasureSnapshot | null,
  proposed: ProposedMeasureChange,
  /** The revision's source text (evidence.description) — diffed against the
   *  live row's description so "Text change" cards show what moved. */
  proposedText?: string,
): RevisionFieldDiff[] {
  if (!live) return [];
  const rows: RevisionFieldDiff[] = [];
  const push = (field: string, a: string, b: string) => {
    if (a !== b) rows.push({ field, live: a, proposed: b });
  };

  push("Name", live.name, proposed.name);
  push(
    "Rate",
    rateLabel({ rate: live.rate, rateText: live.rateText, exemption: live.exemption }),
    rateLabel({ rate: proposed.rate, rateText: proposed.rateText, exemption: proposed.exemption }),
  );
  push("Countries", countriesLabel(live), countriesLabel(proposed));
  push(
    "Coverage",
    coverageLabel(live),
    coverageLabel(proposed),
  );
  if (proposedText !== undefined) {
    push(
      "Source text",
      truncate(live.description),
      truncate(proposedText),
    );
  }
  return rows;
}
