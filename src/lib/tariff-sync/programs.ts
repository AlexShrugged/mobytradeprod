// Legal-program identity and same-program conflict planning — pure, no IO.
//
// A program is one legal action ("the reciprocal tariff", "the fentanyl
// IEEPA order") that CBP publishes as several Chapter 99 headings. The
// calculator enforces one-charge-per-program on read (duty/calculator.ts);
// this module is the WRITE-side counterpart: propose a program for staged
// create_measure revisions, and decide what an apply must do when a new
// measure collides with live measures of the same program.
//
// Inference is deterministic and conservative: a slug is proposed only when
// the description/prefix evidence is unambiguous, otherwise null — and null
// means "lineage unknown, never deduped, never conflict-checked", which is
// the honest failure mode. The reviewer can set or clear the program on the
// card before approving.

import type { MeasureAuthorityValue, MeasureScopeValue } from "../db/schema";
import { normalizeHts } from "../duty/calculator";
import type { ProposedMeasureChange } from "./types";

// Authorities whose enum value IS the program: each of these is a single
// legal action (one Section 232 proclamation per product, one Section 122
// surcharge), so the mapping is 1:1 and needs no text evidence.
const AUTHORITY_PROGRAM: Partial<Record<MeasureAuthorityValue, string>> = {
  section_232_steel: "section-232-steel",
  section_232_aluminum: "section-232-aluminum",
  section_232_copper: "section-232-copper",
  section_232_autos: "section-232-autos",
  section_232_timber_furniture: "section-232-timber-furniture",
  section_232_pharma: "section-232-pharma",
  section_122: "section-122",
  reciprocal: "ieepa-reciprocal",
};

/**
 * Propose a program slug for a Chapter 99 heading. Same inputs as
 * classifyAuthority (differ.ts) — call it right after. Null = not confident;
 * the reviewer decides.
 */
export function inferProgram(
  authority: MeasureAuthorityValue,
  htsno: string,
  description: string,
): string | null {
  const direct = AUTHORITY_PROGRAM[authority];
  if (direct) return direct;

  const d = description.toLowerCase();

  if (authority === "ieepa") {
    // The IEEPA statute hosted several distinct programs that STACKED with
    // each other — the program must split them, never lump them.
    if (d.includes("fentanyl") || d.includes("synthetic opioid")) {
      return "ieepa-fentanyl";
    }
    if (d.includes("canada")) return "ieepa-border-canada";
    if (d.includes("mexico")) return "ieepa-border-mexico";
    // 9903.01.20–.24 are the China/HK opioid headings even where the prose
    // only names the country; the border programs never used this block.
    const digits = normalizeHts(htsno);
    if (
      digits.startsWith("990301") &&
      digits >= "99030120" &&
      digits <= "99030124" &&
      (d.includes("china") || d.includes("hong kong"))
    ) {
      return "ieepa-fentanyl";
    }
    return null;
  }

  if (authority === "section_301") {
    // Distinct 301 investigations are distinct programs (they stack with
    // nothing within themselves but freely with each other's statutes).
    if (d.includes("forced labor") || d.includes("forced labour")) {
      return "section-301-forced-labor";
    }
    // The 2018–2019 China action owns the 9903.88 block.
    if (normalizeHts(htsno).startsWith("990388")) return "section-301-china";
    return null;
  }

  return null;
}

/** The slice of a live measure the conflict check needs. */
export type LiveProgramMeasure = {
  id: string;
  name: string;
  ch99Code: string;
  program: string | null;
  countries: string[] | null;
  effectiveDate: string;
  endDate: string | null;
  scope: MeasureScopeValue;
  prefixes: string[];
  sailedOnOrAfter: string | null;
  sailedOnOrBefore: string | null;
};

function windowsOverlap(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  return (aTo === null || aTo >= bFrom) && (bTo === null || bTo >= aFrom);
}

function prefixSetsIntersect(a: string[], b: string[]): boolean {
  return a.some((pa) => b.some((pb) => pa.startsWith(pb) || pb.startsWith(pa)));
}

function productScopesIntersect(
  aScope: MeasureScopeValue,
  aPrefixes: string[],
  bScope: MeasureScopeValue,
  bPrefixes: string[],
): boolean {
  if (aScope === "all_products" || bScope === "all_products") return true;
  return prefixSetsIntersect(aPrefixes, bPrefixes);
}

type ProposedOverlapFields = Pick<
  ProposedMeasureChange,
  | "program"
  | "countries"
  | "effectiveDate"
  | "endDate"
  | "scope"
  | "prefixes"
  | "exemption"
  | "sailedOnOrAfter"
  | "sailedOnOrBefore"
>;

type SailWindow = {
  sailedOnOrAfter: string | null;
  sailedOnOrBefore: string | null;
};

/** Provably no lading date satisfies both measures: one side's sail window
 *  ends strictly before the other's begins. Null bounds are open — a
 *  measure with no sail conditions claims every sail date and is never
 *  disjoint from anything. */
function sailWindowsDisjoint(a: SailWindow, b: SailWindow): boolean {
  return (
    (a.sailedOnOrBefore !== null &&
      b.sailedOnOrAfter !== null &&
      a.sailedOnOrBefore < b.sailedOnOrAfter) ||
    (b.sailedOnOrBefore !== null &&
      a.sailedOnOrAfter !== null &&
      b.sailedOnOrBefore < a.sailedOnOrAfter)
  );
}

/** Same program, same country tier, intersecting product scope, entry
 *  windows that overlap (a null proposed effective date counts as
 *  overlapping — pre-review, the window is simply not settled yet).
 *  Sail conditions are NOT considered here. */
function overlapsIgnoringSail(
  proposed: ProposedOverlapFields,
  m: LiveProgramMeasure,
): boolean {
  if (m.program !== proposed.program) return false;
  if (
    proposed.effectiveDate !== null &&
    !windowsOverlap(
      proposed.effectiveDate,
      proposed.endDate,
      m.effectiveDate,
      m.endDate,
    )
  ) {
    return false;
  }
  if (
    !productScopesIntersect(
      proposed.scope,
      proposed.prefixes,
      m.scope,
      m.prefixes,
    )
  ) {
    return false;
  }
  if (proposed.countries === null || m.countries === null) {
    // Same-tier only: worldwide vs worldwide conflicts, worldwide vs
    // country-specific coexists by design.
    return proposed.countries === null && m.countries === null;
  }
  return proposed.countries.some((c) => m.countries!.includes(c));
}

/**
 * Live measures a proposed create_measure genuinely collides with: same
 * program, overlapping entry windows, intersecting product scope, and the
 * SAME country tier — both worldwide (countries null) or explicit country
 * lists that intersect. A worldwide baseline coexisting with a
 * country-specific heading is NOT a conflict: that is the published shape
 * of these programs (9903.01.25 alongside the per-country headings), and
 * the calculator resolves it per line by specificity. The dangerous
 * overlaps are same-tier — two worldwide baselines, or two headings
 * claiming the same country — which is exactly how the stacked-IEEPA
 * incident was minted.
 *
 * A pair whose sail windows are provably disjoint is NOT a conflict either:
 * that is a sail-date cutover (the on-the-water pattern — the old rate
 * lingers only for goods already laden), a supersession the entry-date
 * window model must represent as two simultaneously live measures. The
 * calculator picks exactly one per entry by sail date. See
 * findSailPartitioned for surfacing these to the reviewer.
 */
export function findProgramConflicts(
  proposed: ProposedOverlapFields,
  live: LiveProgramMeasure[],
): LiveProgramMeasure[] {
  if (proposed.exemption) return [];
  if (!proposed.program) return [];

  return live.filter(
    (m) => overlapsIgnoringSail(proposed, m) && !sailWindowsDisjoint(proposed, m),
  );
}

/** Live measures the proposal would collide with EXCEPT that disjoint sail
 *  windows partition them — the pair coexists, and per entry the sail date
 *  picks the one that charges. Review-card note material only; these need
 *  no resolution at apply. */
export function findSailPartitioned(
  proposed: ProposedOverlapFields,
  live: LiveProgramMeasure[],
): LiveProgramMeasure[] {
  if (proposed.exemption) return [];
  if (!proposed.program) return [];

  return live.filter(
    (m) => overlapsIgnoringSail(proposed, m) && sailWindowsDisjoint(proposed, m),
  );
}

export type ProgramResolution =
  | { kind: "proceed" }
  | {
      kind: "supersede";
      /** Conflicting live windows to close at proposed effective − 1 day
       *  (only those still open past it — same rule as same-code tiling). */
      closeMeasureIds: string[];
      /** Window lineage: the latest-starting conflict becomes the new
       *  measure's predecessor. */
      predecessorId: string;
    }
  | { kind: "error"; message: string };

/**
 * Pure decision for an insert_new apply against its program conflicts.
 * No conflicts → proceed. Conflicts SUPERSEDE automatically: a same-tier,
 * same-scope collision inside one program has exactly one legal meaning —
 * the new measure replaces the old ones, whose windows close the day
 * before it starts (the review cards disclose this per line before
 * approval). The only fail-closed case left is a conflict that starts on
 * or after the proposal — "superseding" it would extend history backwards,
 * so the dates must be wrong. Sail-partitioned pairs never reach here
 * (findProgramConflicts excludes them).
 */
export function planProgramResolution(
  proposed: Pick<ProposedMeasureChange, "program" | "effectiveDate">,
  conflicts: LiveProgramMeasure[],
): ProgramResolution {
  if (conflicts.length === 0) return { kind: "proceed" };

  const notEarlier = conflicts.filter(
    (c) => c.effectiveDate >= proposed.effectiveDate!,
  );
  if (notEarlier.length > 0) {
    const list = notEarlier
      .map((c) => `${c.name} (${c.ch99Code}, effective ${c.effectiveDate})`)
      .join("; ");
    return {
      kind: "error",
      message:
        `Overlaps live ${proposed.program} measure(s) that start on or ` +
        `after this one's effective date (${proposed.effectiveDate}): ` +
        `${list}. A new measure only supersedes earlier ones. Fix the ` +
        `dates, or end the newer measure first.`,
    };
  }
  const latest = conflicts.reduce((w, c) =>
    c.effectiveDate > w.effectiveDate ? c : w,
  );
  return {
    kind: "supersede",
    closeMeasureIds: conflicts.map((c) => c.id),
    predecessorId: latest.id,
  };
}
